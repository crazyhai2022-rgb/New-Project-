(function () {
  const CODE = decodeURIComponent(window.location.pathname.split('/').pop()).toUpperCase();
  const teacherName = sessionStorage.getItem('lcb_teacherName') || 'Teacher';

  const socket = io({ reconnectionAttempts: Infinity });

  const el = (id) => document.getElementById(id);
  const connStatus = el('connStatus');
  const sessionPill = el('sessionPill');

  let currentMode = 'code';
  let monacoEditor = null;
  let monacoReady = false;
  let pendingCodeApply = null;
  let usingFallbackEditor = false;

  // Declared up front so an exception anywhere below (e.g. a slow/blocked
  // CDN) can never leave these in the temporal dead zone for a handler
  // that fires early, like the socket 'connect' callback.
  let strokes = [];
  let redoStack = [];

  // ---------------------------------------------------------------- setup

  el('sessionCodeDisplay').textContent = CODE;
  const joinUrl = `${window.location.origin}/join/${CODE}`;
  el('joinLinkInput').value = joinUrl;

  if (window.QRCode) {
    QRCode.toCanvas(document.createElement('canvas'), joinUrl); // warm up lib (no-op safeguard)
    const canvas = document.createElement('canvas');
    QRCode.toCanvas(canvas, joinUrl, { width: 160, margin: 1, color: { dark: '#1a2840', light: '#ffffff' } }, function (err) {
      if (!err) el('qrHost').appendChild(canvas);
    });
  }

  el('copyLinkBtn').addEventListener('click', async function () {
    await navigator.clipboard.writeText(joinUrl);
    this.textContent = 'Copied!';
    setTimeout(() => (this.textContent = 'Copy'), 1400);
  });

  // ------------------------------------------------------------- connect

  function setConnPill(state) {
    connStatus.className = 'pill ' + (state === 'connected' ? 'pill-live' : state === 'reconnecting' ? 'pill-paused' : 'pill-off');
    connStatus.innerHTML = '<span class="dot"></span>' +
      (state === 'connected' ? 'Connected' : state === 'reconnecting' ? 'Reconnecting…' : 'Disconnected');
  }

  socket.on('connect', function () {
    setConnPill('connected');
    socket.emit('teacher:attach', { code: CODE }, function (res) {
      if (!res.ok) {
        alert(res.error || 'This class no longer exists.');
        window.location.href = '/';
        return;
      }
      hydrate(res.session, res.students);
    });
  });
  socket.io.on('reconnect_attempt', () => setConnPill('reconnecting'));
  socket.on('disconnect', () => setConnPill('disconnected'));

  function hydrate(session, students) {
    el('subjectTitle').textContent = session.subject;
    el('classSubtitle').textContent = [session.className, session.topic].filter(Boolean).join(' · ');
    document.title = session.subject + ' — LiveClass Board';

    setMode(session.mode, { silent: true });
    el('langSelect').value = session.board.code.language;
    document.querySelectorAll('.lang-btn').forEach((b) => b.classList.toggle('on', b.dataset.lang === session.board.code.language));
    applyCodeToEditor(session.board.code.content);
    el('notesArea').value = session.board.notes.content;
    replaceWhiteboard(session.board.whiteboard.strokes);

    renderStudents({ count: students.length, list: students });
    setPill(session.paused ? 'paused' : 'live');
  }

  // ---------------------------------------------------------------- mode

  document.querySelectorAll('.mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  function setMode(mode, opts = {}) {
    currentMode = mode;
    document.querySelectorAll('.mode-tab').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    document.querySelectorAll('.mode-body').forEach((b) => b.classList.toggle('hidden', b.id !== 'mode-' + mode));
    if (mode === 'code' && monacoReady) setTimeout(() => monacoEditor.layout(), 50);
    if (!opts.silent) socket.emit('teacher:setMode', { mode });
  }

  // ----------------------------------------------------------- code mode

  // Monaco loads from a CDN; on a slow connection (or one that blocks it)
  // the classroom shouldn't be stuck — fall back to a plain textarea that
  // still syncs perfectly, just without syntax highlighting while typing.
  let monacoLoadTimedOut = false;
  const monacoTimer = setTimeout(function () {
    if (!monacoReady) { monacoLoadTimedOut = true; useFallbackEditor(); }
  }, 4000);

  try {
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
    require(['vs/editor/editor.main'], function () {
      clearTimeout(monacoTimer);
      if (monacoLoadTimedOut) return; // fallback already took over; don't double-init
      initMonaco();
    }, function () {
      clearTimeout(monacoTimer);
      useFallbackEditor();
    });
  } catch {
    clearTimeout(monacoTimer);
    useFallbackEditor();
  }

  function currentMonacoTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs';
  }

  function initMonaco() {
    monacoEditor = monaco.editor.create(el('monacoHost'), {
      value: pendingCodeApply || '',
      language: monacoLangFor(el('langSelect').value),
      theme: currentMonacoTheme(),
      fontSize: 14,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
    });
    monacoReady = true;
    pendingCodeApply = null;

    // Keep Monaco's own theme in sync with the site-wide dark/light toggle —
    // otherwise the editor is stuck on a light background no matter what.
    window.addEventListener('lcb:theme-changed', function () {
      monaco.editor.setTheme(currentMonacoTheme());
    });

    registerSnippetSuggestions();

    let debounce = null;
    monacoEditor.onDidChangeModelContent(function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        socket.emit('teacher:updateCode', {
          language: el('langSelect').value,
          content: monacoEditor.getValue(),
        });
        updatePreview();
      }, 220); // debounced — see README for why full-content sync was chosen over OT for the MVP
    });
  }

  // A real, dismissible suggestion — like VS Code's Emmet popup — rather
  // than forcing the boilerplate on anyone who happens to type "#" or "!".
  // Pressing Tab/Enter accepts it; typing on, or Escape, just drops it.
  let snippetProvidersRegistered = false;
  function registerSnippetSuggestions() {
    if (snippetProvidersRegistered) return;
    snippetProvidersRegistered = true;

    monaco.languages.registerCompletionItemProvider('c', snippetProviderFor('c', '#'));
    monaco.languages.registerCompletionItemProvider('cpp', snippetProviderFor('cpp', '#'));
    monaco.languages.registerCompletionItemProvider('html', snippetProviderFor('html', '!'));
  }

  function snippetProviderFor(lang, triggerChar) {
    return {
      triggerCharacters: [triggerChar],
      provideCompletionItems(model, position) {
        // Only offer it on an otherwise-empty document — this is a starter
        // template, not something useful mid-file.
        if (model.getValueLength() > 1) return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
          startColumn: 1, endColumn: position.column,
        };
        const raw = STARTERS[lang].replace(CURSOR_MARK, '');
        const label = lang === 'html' ? '! — HTML5 boilerplate' : '# — Starter code (#include + main)';

        return {
          suggestions: [{
            label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            documentation: raw,
            insertText: toMonacoSnippet(STARTERS[lang]),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          }],
        };
      },
    };
  }

  /** Turns our ␘CURSOR␘ marker into Monaco's $0 final-cursor-stop syntax. */
  function toMonacoSnippet(text) {
    return text.replace(CURSOR_MARK, '$0');
  }

  function useFallbackEditor() {
    if (usingFallbackEditor || monacoReady) return;
    usingFallbackEditor = true;
    const host = el('monacoHost');
    host.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.id = 'fallbackCodeArea';
    ta.style.cssText = 'width:100%;height:100%;border:none;padding:16px 20px;font-family:Consolas,Monaco,monospace;font-size:14px;line-height:1.6;resize:none;background:var(--surface);color:var(--ink);';
    ta.value = pendingCodeApply || '';
    ta.placeholder = 'Type your code here… (try # for C/C++ or ! for HTML on an empty file)';
    host.appendChild(ta);

    setupFallbackSuggestionChip(ta);

    let debounce = null;
    ta.addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        socket.emit('teacher:updateCode', { language: el('langSelect').value, content: ta.value });
        updatePreview();
      }, 220);
    });

    // Give the rest of the app the same interface it would have with Monaco.
    monacoEditor = {
      getValue: () => ta.value,
      setValue: (v) => { ta.value = v || ''; },
      layout: () => {},
    };
    monacoReady = true;
    pendingCodeApply = null;
  }

  function applyCodeToEditor(content) {
    if (monacoReady) monacoEditor.setValue(content || '');
    else pendingCodeApply = content || '';
  }

  el('langSelect').addEventListener('change', function () {
    if (monacoReady && !usingFallbackEditor) monaco.editor.setModelLanguage(monacoEditor.getModel(), monacoLangFor(this.value));
    socket.emit('teacher:updateCode', { language: this.value, content: monacoReady ? monacoEditor.getValue() : '' });
    updatePreview();
  });

  // Colourful icon buttons drive the same hidden <select> everything else
  // already listens to — nothing downstream needs to know the UI changed.
  document.querySelectorAll('.lang-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.lang-btn').forEach((b) => b.classList.toggle('on', b === btn));
      const select = el('langSelect');
      select.value = btn.dataset.lang;
      select.dispatchEvent(new Event('change'));
    });
  });

  function monacoLangFor(v) {
    return { cpp: 'cpp', c: 'c', java: 'java', python: 'python', javascript: 'javascript', html: 'html', css: 'css', sql: 'sql' }[v] || 'plaintext';
  }

  // ---------------------------------------------------------- notes mode

  let notesDebounce = null;
  el('notesArea').addEventListener('input', function () {
    clearTimeout(notesDebounce);
    notesDebounce = setTimeout(() => socket.emit('teacher:updateNotes', { content: this.value }), 200);
  });

  // ------------------------------------------------------ whiteboard mode

  const canvas = el('wbCanvas');
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let currentStroke = null;
  let tool = 'pen';

  document.querySelectorAll('.wb-tool').forEach((btn) => {
    btn.addEventListener('click', () => {
      tool = btn.dataset.tool;
      document.querySelectorAll('.wb-tool').forEach((b) => b.classList.toggle('on', b === btn));
    });
  });

  function canvasPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const t = e.touches ? e.touches[0] : e;
    return [(t.clientX - rect.left) * scaleX, (t.clientY - rect.top) * scaleY];
  }

  function startDraw(e) {
    e.preventDefault();
    drawing = true;
    currentStroke = {
      color: el('wbColor').value,
      width: Number(el('wbWidth').value),
      erase: tool === 'eraser',
      points: [canvasPoint(e)],
    };
  }
  function moveDraw(e) {
    if (!drawing) return;
    e.preventDefault();
    currentStroke.points.push(canvasPoint(e));
    redrawAll();
    drawStroke(currentStroke);
  }
  function endDraw() {
    if (!drawing) return;
    drawing = false;
    if (currentStroke.points.length > 1) {
      strokes.push(currentStroke);
      redoStack = [];
      socket.emit('teacher:whiteboardStroke', currentStroke);
    }
    currentStroke = null;
  }

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', moveDraw);
  window.addEventListener('mouseup', endDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', moveDraw, { passive: false });
  canvas.addEventListener('touchend', endDraw);

  function drawStroke(stroke) {
    if (stroke.points.length < 2) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = stroke.width;
    ctx.strokeStyle = stroke.erase ? '#ffffff' : stroke.color;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
    for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
    ctx.stroke();
    ctx.restore();
  }

  function redrawAll() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    strokes.forEach(drawStroke);
  }

  function replaceWhiteboard(list) {
    strokes = Array.isArray(list) ? list.slice() : [];
    redoStack = [];
    redrawAll();
  }

  el('wbUndo').addEventListener('click', function () {
    if (!strokes.length) return;
    redoStack.push(strokes.pop());
    redrawAll();
    socket.emit('teacher:whiteboardReplace', { strokes });
  });
  el('wbRedo').addEventListener('click', function () {
    if (!redoStack.length) return;
    strokes.push(redoStack.pop());
    redrawAll();
    socket.emit('teacher:whiteboardReplace', { strokes });
  });
  el('wbClear').addEventListener('click', function () {
    if (!confirm('Clear the whole whiteboard for everyone?')) return;
    strokes = [];
    redoStack = [];
    redrawAll();
    socket.emit('teacher:whiteboardClear');
  });

  // ------------------------------------------------------ session controls

  let paused = false;
  function setPill(state) {
    if (state === 'paused') {
      sessionPill.className = 'pill pill-paused';
      sessionPill.innerHTML = '<span class="dot"></span>PAUSED';
      el('pauseBtn').textContent = 'Resume Class';
      paused = true;
    } else {
      sessionPill.className = 'pill pill-live';
      sessionPill.innerHTML = '<span class="dot"></span>LIVE';
      el('pauseBtn').textContent = 'Pause Class';
      paused = false;
    }
  }

  el('pauseBtn').addEventListener('click', function () {
    socket.emit(paused ? 'teacher:resume' : 'teacher:pause');
    setPill(paused ? 'live' : 'paused');
  });

  el('endBtn').addEventListener('click', () => el('endModal').classList.remove('hidden'));
  el('endCancelBtn').addEventListener('click', () => el('endModal').classList.add('hidden'));
  el('endConfirmBtn').addEventListener('click', function () {
    socket.emit('teacher:end');
    window.location.href = '/';
  });

  // ---------------------------------------------------------------- roster

  const raisedHands = new Set();

  function renderStudents({ count, list }) {
    el('studentCount').textContent = count;
    const ul = el('studentList');
    if (!list.length) {
      ul.innerHTML = '<li class="empty-note">No students yet.</li>';
      return;
    }
    ul.innerHTML = list.map((s) => {
      const initial = (s.name || '?').trim().charAt(0).toUpperCase();
      const hand = raisedHands.has(s.id) ? '<span class="hand-badge" title="Hand raised">✋</span>' : '';
      return `<li data-id="${escapeHtml(s.id)}"><span class="avatar">${initial}</span>${escapeHtml(s.name)}${hand}</li>`;
    }).join('');
  }

  socket.on('students:update', renderStudents);

  socket.on('student:handRaised', function ({ studentId, raised }) {
    if (raised) raisedHands.add(studentId);
    else raisedHands.delete(studentId);

    const li = el('studentList').querySelector(`li[data-id="${studentId}"]`);
    if (!li) return; // roster hasn't rendered this student yet — the next students:update will pick up raisedHands anyway
    const existing = li.querySelector('.hand-badge');
    if (raised && !existing) li.insertAdjacentHTML('beforeend', '<span class="hand-badge" title="Hand raised">✋</span>');
    if (!raised && existing) existing.remove();
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // -------------------------------------------------------- notes & pdf

  el('generateNotesBtn').addEventListener('click', async function () {
    this.disabled = true;
    this.innerHTML = '<span class="spinner"></span> Generating…';
    try {
      const preview = buildPreviewText();
      el('notesPreview').textContent = preview || '(Nothing captured yet — write something first.)';
      el('notesPreview').classList.remove('hidden');
      el('notesActions').classList.remove('hidden');
      el('attendanceLink').href = `/api/classes/${CODE}/attendance.csv`;
    } finally {
      this.disabled = false;
      this.textContent = 'Generate Notes';
    }
  });

  function buildPreviewText() {
    const parts = [];
    if (el('notesArea').value.trim()) parts.push('NOTES\n' + el('notesArea').value.trim());
    if (monacoReady && monacoEditor.getValue().trim()) parts.push('CODE (' + el('langSelect').value + ')\n' + monacoEditor.getValue().trim());
    if (strokes.length) parts.push('WHITEBOARD\n' + strokes.length + ' strokes recorded.');
    return parts.join('\n\n');
  }

  el('downloadPdfBtn').addEventListener('click', async function () {
    this.disabled = true;
    this.innerHTML = '<span class="spinner"></span> Building PDF…';
    try {
      const payload = { teacherName };
      if (strokes.length) payload.whiteboardImage = canvas.toDataURL('image/png');

      const res = await fetch(`/api/classes/${CODE}/notes.pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('PDF generation failed.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'class-notes.pdf';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.message);
    } finally {
      this.disabled = false;
      this.textContent = 'Download PDF';
    }
  });

  el('shareNotesBtn').addEventListener('click', async function () {
    const shareData = { title: el('subjectTitle').textContent, text: 'Class notes from LiveClass Board', url: joinUrl };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch {}
    } else {
      await navigator.clipboard.writeText(joinUrl);
      this.textContent = 'Link copied!';
      setTimeout(() => (this.textContent = 'Share'), 1400);
    }
  });

  // ------------------------------ collapsible side panel ------------------------------
  (function () {
    const layout = document.querySelector('.layout');
    const collapseBtn = el('collapsePanelBtn');
    const expandTab = el('expandPanelBtn');
    if (!layout || !collapseBtn || !expandTab) return;

    function setCollapsed(collapsed) {
      layout.classList.toggle('panel-collapsed', collapsed);
      expandTab.classList.toggle('hidden', !collapsed);
      if (monacoReady && monacoEditor.layout) setTimeout(() => monacoEditor.layout(), 60);
    }
    collapseBtn.addEventListener('click', () => setCollapsed(true));
    expandTab.addEventListener('click', () => setCollapsed(false));
  })();

  // ------------------------------ drag-to-resize side panel ------------------------------
  (function () {
    const resizer = el('panelResizer');
    const layout = document.querySelector('.layout');
    if (!resizer || !layout) return;

    const MIN_WIDTH = 240;
    const MAX_WIDTH = 560;
    let dragging = false;

    resizer.addEventListener('mousedown', function (e) {
      e.preventDefault();
      dragging = true;
      resizer.classList.add('dragging');
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX - 26));
      layout.style.setProperty('--panel-width', width + 'px');
    });

    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.style.userSelect = '';
      if (monacoReady && monacoEditor.layout) monacoEditor.layout();
    });

    // Touch support, for teachers on a tablet.
    resizer.addEventListener('touchstart', function () { dragging = true; resizer.classList.add('dragging'); }, { passive: true });
    window.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      const x = e.touches[0].clientX;
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - x - 26));
      layout.style.setProperty('--panel-width', width + 'px');
    }, { passive: true });
    window.addEventListener('touchend', function () {
      dragging = false;
      resizer.classList.remove('dragging');
    });
  })();

  // ------------------------------ starter code / snippets ------------------------------
  const CURSOR_MARK = '\u2038CURSOR\u2038';
  const STARTERS = {
    c: `#include <stdio.h>\n\nint main() {\n    ${CURSOR_MARK}\n    return 0;\n}\n`,
    cpp: `#include <iostream>\nusing namespace std;\n\nint main() {\n    ${CURSOR_MARK}\n    return 0;\n}\n`,
    java: `public class Main {\n    public static void main(String[] args) {\n        ${CURSOR_MARK}\n    }\n}\n`,
    python: `def main():\n    ${CURSOR_MARK}\n\nif __name__ == "__main__":\n    main()\n`,
    javascript: `function main() {\n    ${CURSOR_MARK}\n}\n\nmain();\n`,
    html: `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Document</title>\n</head>\n<body>\n    ${CURSOR_MARK}\n</body>\n</html>\n`,
    css: `body {\n    margin: 0;\n    font-family: sans-serif;\n    ${CURSOR_MARK}\n}\n`,
    sql: `SELECT ${CURSOR_MARK}\nFROM table_name\nWHERE condition;\n`,
  };

  function currentEditorValue() {
    return monacoReady ? monacoEditor.getValue() : '';
  }

  function applySnippet(text) {
    const cursorIndex = text.indexOf(CURSOR_MARK);
    const clean = text.replace(CURSOR_MARK, '');

    if (monacoReady && !usingFallbackEditor) {
      monacoEditor.setValue(clean);
      if (cursorIndex >= 0) {
        const pos = monacoEditor.getModel().getPositionAt(cursorIndex);
        monacoEditor.setPosition(pos);
        monacoEditor.focus();
      }
    } else if (usingFallbackEditor) {
      const ta = document.getElementById('fallbackCodeArea');
      ta.value = clean;
      if (cursorIndex >= 0) ta.setSelectionRange(cursorIndex, cursorIndex);
      ta.focus();
    }
    socket.emit('teacher:updateCode', { language: el('langSelect').value, content: clean });
  }

  el('insertStarterBtn').addEventListener('click', function () {
    const lang = el('langSelect').value;
    const starter = STARTERS[lang];
    if (!starter) return;
    if (currentEditorValue().trim() && !confirm('Replace the current code with a starter template for ' + lang.toUpperCase() + '?')) return;
    applySnippet(starter);
  });

  // Emmet-style suggestion for the fallback textarea (no Monaco = no native
  // suggestion widget): a small dismissible chip appears near the trigger
  // character; Tab accepts it, Escape or continued typing dismisses it.
  function setupFallbackSuggestionChip(ta) {
    const chip = document.createElement('div');
    chip.className = 'snippet-chip hidden';
    ta.parentElement.style.position = 'relative';
    ta.parentElement.appendChild(chip);

    let pendingLang = null;

    function hide() { chip.classList.add('hidden'); pendingLang = null; }

    ta.addEventListener('input', function () {
      const lang = el('langSelect').value;
      const isTrigger =
        (ta.value === '#' && (lang === 'c' || lang === 'cpp')) ||
        (ta.value === '!' && lang === 'html');

      if (!isTrigger) { hide(); return; }
      pendingLang = lang;
      chip.textContent = (lang === 'html' ? '! ' : '# ') + '→ Tab to insert starter code · Esc to dismiss';
      chip.classList.remove('hidden');
    });

    ta.addEventListener('keydown', function (e) {
      if (!pendingLang) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        applySnippet(STARTERS[pendingLang]);
        hide();
      } else if (e.key === 'Escape') {
        hide();
      } else if (e.key.length === 1 || e.key === 'Backspace') {
        // Any further typing abandons the suggestion, same as VS Code.
        hide();
      }
    });

    ta.addEventListener('blur', hide);
  }

  // ------------------------------ live preview ------------------------------
  function buildPreviewHtml(lang, content) {
    if (lang === 'html') {
      return /<html[\s>]/i.test(content) ? content : `<!DOCTYPE html><html><body>${content}</body></html>`;
    }
    if (lang === 'css') {
      return `<!DOCTYPE html><html><head><style>${content}</style></head>
        <body><h1>Heading</h1><p>Paragraph text to preview your CSS against.</p>
        <button>Button</button></body></html>`;
    }
    if (lang === 'javascript') {
      return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:14px;">
        <div id="out" style="white-space:pre-wrap;font-family:monospace;font-size:13px;"></div>
        <script>
          const out = document.getElementById('out');
          console.log = (...a) => { out.textContent += a.join(' ') + '\\n'; };
        <\/script>
        <script>${content}<\/script>
        </body></html>`;
    }
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;color:#888;">
      Live Preview works for HTML, CSS and JavaScript.</body></html>`;
  }

  function updatePreview() {
    const frame = el('previewFrame');
    if (!frame || el('previewPanel').classList.contains('hidden')) return;
    frame.srcdoc = buildPreviewHtml(el('langSelect').value, currentEditorValue());
  }

  el('previewToggle').addEventListener('change', function () {
    el('previewPanel').classList.toggle('hidden', !this.checked);
    socket.emit('teacher:previewToggle', { enabled: this.checked });
    if (this.checked) updatePreview();
    if (monacoReady && monacoEditor.layout) setTimeout(() => monacoEditor.layout(), 60);
  });
  el('previewCloseBtn').addEventListener('click', function () {
    el('previewToggle').checked = false;
    el('previewPanel').classList.add('hidden');
    socket.emit('teacher:previewToggle', { enabled: false });
  });

  // ------------------------------ keystroke overlay toggle ------------------------------
  function formatKey(e) {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
    const named = { ' ': 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: '⌫', Escape: 'Esc' };
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Cmd');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey && e.key.length > 1) parts.push('Shift');
    parts.push(named[e.key] || (e.key.length === 1 ? e.key : e.key));
    return parts.join(' + ');
  }

  let keystrokesOn = false;
  document.addEventListener('keydown', function (e) {
    if (!keystrokesOn) return;
    const label = formatKey(e);
    if (label) socket.emit('teacher:keystroke', { label });
  });

  el('keystrokesToggle').addEventListener('change', function () {
    keystrokesOn = this.checked;
    socket.emit('teacher:keystrokesToggle', { enabled: keystrokesOn });
  });
})();
