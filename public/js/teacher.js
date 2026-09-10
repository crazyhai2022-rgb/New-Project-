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

  function initMonaco() {
    monacoEditor = monaco.editor.create(el('monacoHost'), {
      value: pendingCodeApply || '',
      language: monacoLangFor(el('langSelect').value),
      theme: 'vs',
      fontSize: 14,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
    });
    monacoReady = true;
    pendingCodeApply = null;

    let debounce = null;
    monacoEditor.onDidChangeModelContent(function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        socket.emit('teacher:updateCode', {
          language: el('langSelect').value,
          content: monacoEditor.getValue(),
        });
      }, 220); // debounced — see README for why full-content sync was chosen over OT for the MVP
    });
  }

  function useFallbackEditor() {
    if (usingFallbackEditor || monacoReady) return;
    usingFallbackEditor = true;
    const host = el('monacoHost');
    host.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.id = 'fallbackCodeArea';
    ta.style.cssText = 'width:100%;height:100%;border:none;padding:16px 20px;font-family:Consolas,Monaco,monospace;font-size:14px;line-height:1.6;resize:none;';
    ta.value = pendingCodeApply || '';
    ta.placeholder = 'Type your code here…';
    host.appendChild(ta);

    let debounce = null;
    ta.addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        socket.emit('teacher:updateCode', { language: el('langSelect').value, content: ta.value });
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

  function renderStudents({ count, list }) {
    el('studentCount').textContent = count;
    const ul = el('studentList');
    if (!list.length) {
      ul.innerHTML = '<li class="empty-note">No students yet.</li>';
      return;
    }
    ul.innerHTML = list.map((s) => {
      const initial = (s.name || '?').trim().charAt(0).toUpperCase();
      return `<li><span class="avatar">${initial}</span>${escapeHtml(s.name)}</li>`;
    }).join('');
  }

  socket.on('students:update', renderStudents);

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
})();
