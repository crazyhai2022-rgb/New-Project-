(function () {
  const el = (id) => document.getElementById(id);
  const urlCode = decodeURIComponent(window.location.pathname.split('/').pop() || '').toUpperCase();
  const isJoinRoute = window.location.pathname.startsWith('/join/');

  if (isJoinRoute && /^[A-Z0-9]{4,8}$/.test(urlCode)) {
    el('classCode').value = urlCode;
    fetch(`/api/classes/${urlCode}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) el('classPreview').textContent = `${d.subject}${d.className ? ' · ' + d.className : ''} — with ${d.teacherName}`;
        else el('classPreview').textContent = d.error || 'Class not found.';
      })
      .catch(() => (el('classPreview').textContent = 'Enter your details to join.'));
  } else {
    el('classPreview').textContent = 'Enter your details to join.';
  }

  let socket = null;
  let studentId = null;
  let sessionCode = null;

  // ------------------------------------------------------------- join form

  el('joinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const btn = el('joinBtn');
    const errBox = el('joinError');
    errBox.innerHTML = '';
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Joining…';

    const name = el('studentName').value.trim();
    const code = el('classCode').value.trim().toUpperCase();

    socket = io({ reconnectionAttempts: Infinity });

    socket.on('connect', function () {
      socket.emit('student:join', { code, studentName: name }, function (res) {
        if (!res.ok) {
          errBox.innerHTML = '<div class="alert alert-error">' + res.error + '</div>';
          btn.disabled = false;
          btn.textContent = 'Join Class';
          socket.disconnect();
          socket = null;
          return;
        }
        studentId = res.studentId;
        sessionCode = code;
        sessionStorage.setItem('lcb_join', JSON.stringify({ code, name }));
        enterViewer(res.session);
      });
    });

    socket.on('connect_error', function () {
      errBox.innerHTML = '<div class="alert alert-error">Could not reach the server. Please try again.</div>';
      btn.disabled = false;
      btn.textContent = 'Join Class';
    });
  });

  // -------------------------------------------------------------- viewer

  function enterViewer(session) {
    el('joinScreen').classList.add('hidden');
    el('viewer').classList.remove('hidden');

    el('vSubject').textContent = session.subject;
    el('vClass').textContent = [session.className, session.topic].filter(Boolean).join(' · ');
    document.title = session.subject + ' — LiveClass Board';

    setMode(session.mode);
    applyCode(session.board.code);
    applyNotes(session.board.notes.content);
    replaceWhiteboard(session.board.whiteboard.strokes);
    if (session.paused) showPaused(true);
    if (session.previewEnabled) applyPreview(true);

    wireSocketEvents();
    fitToScreen();
  }

  function wireSocketEvents() {
    socket.io.on('reconnect_attempt', () => setConn('reconnecting'));
    socket.on('connect', () => {
      setConn('connected');
      // A silent rejoin after a real network drop re-syncs the full board,
      // in case something happened while this student was offline.
      if (studentId) {
        socket.emit('student:join', { code: sessionCode, studentName: JSON.parse(sessionStorage.getItem('lcb_join') || '{}').name }, function (res) {
          if (res.ok) {
            applyCode(res.session.board.code);
            applyNotes(res.session.board.notes.content);
            replaceWhiteboard(res.session.board.whiteboard.strokes);
            setMode(res.session.mode);
            showPaused(!!res.session.paused);
            applyPreview(!!res.session.previewEnabled);
          }
        });
      }
    });
    socket.on('disconnect', () => setConn('disconnected'));

    socket.on('mode:changed', ({ mode }) => setMode(mode));
    socket.on('board:code', applyCode);
    socket.on('board:notes', (n) => applyNotes(n.content));
    socket.on('board:whiteboardStroke', drawIncomingStroke);
    socket.on('board:whiteboardReplace', ({ strokes }) => replaceWhiteboard(strokes));

    socket.on('students:update', ({ count }) => {
      el('vCount').textContent = count + (count === 1 ? ' student' : ' students');
    });

    socket.on('board:previewToggled', ({ enabled }) => applyPreview(enabled));
    socket.on('board:keystroke', ({ label }) => showKeyChip(label));

    socket.on('session:paused', () => showPaused(true));
    socket.on('session:resumed', () => showPaused(false));

    socket.on('session:ended', function () {
      el('viewer').classList.add('hidden');
      el('endScreen').classList.remove('hidden');
    });
  }

  function setConn(state) {
    const pill = el('vConn');
    pill.className = 'pill ' + (state === 'connected' ? 'pill-live' : state === 'reconnecting' ? 'pill-paused' : 'pill-off');
    pill.innerHTML = '<span class="dot"></span>' +
      (state === 'connected' ? 'LIVE' : state === 'reconnecting' ? 'Reconnecting…' : 'Disconnected');
  }

  function showPaused(isPaused) {
    el('pausedBanner').classList.toggle('hidden', !isPaused);
  }

  // ---------------------------------------------------------------- modes

  const MODE_LABELS = { code: '💻 Code', notes: '📝 Notes', whiteboard: '🖊 Whiteboard' };

  function setMode(mode) {
    el('vModeLabel').textContent = MODE_LABELS[mode] || mode;
    el('codeView').classList.toggle('hidden', mode !== 'code');
    el('notesView').classList.toggle('hidden', mode !== 'notes');
    el('wbView').classList.toggle('hidden', mode !== 'whiteboard');
  }

  let lastCodeState = { language: 'plaintext', content: '' };

  function applyCode(codeState) {
    lastCodeState = codeState || lastCodeState;
    const codeEl = el('codeViewInner');
    codeEl.textContent = codeState.content || '';
    codeEl.className = 'language-' + (codeState.language || 'plaintext');
    if (window.hljs) {
      codeEl.removeAttribute('data-highlighted');
      hljs.highlightElement(codeEl);
    }
    updateStudentPreview();
  }

  function applyNotes(text) {
    const container = el('notesView');
    const lines = String(text || '').split('\n');
    container.innerHTML = lines.map((line) => {
      if (line.startsWith('# ')) return `<h3>${escapeHtml(line.slice(2))}</h3>`;
      if (line.startsWith('- ')) return `<div class="bullet">${escapeHtml(line.slice(2))}</div>`;
      return `<div>${escapeHtml(line) || '&nbsp;'}</div>`;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------ whiteboard

  const wbCanvas = el('wbView');
  const wbCtx = wbCanvas.getContext('2d');
  let wbStrokes = [];

  function drawStroke(ctx, stroke) {
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

  function redrawWhiteboard() {
    wbCtx.clearRect(0, 0, wbCanvas.width, wbCanvas.height);
    wbCtx.fillStyle = '#ffffff';
    wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height);
    wbStrokes.forEach((s) => drawStroke(wbCtx, s));
  }

  function replaceWhiteboard(list) {
    wbStrokes = Array.isArray(list) ? list.slice() : [];
    redrawWhiteboard();
  }

  function drawIncomingStroke(stroke) {
    wbStrokes.push(stroke);
    drawStroke(wbCtx, stroke);
  }

  // ------------------------------------------------------------------ zoom
  //
  // Zoom is 100% local: it scales `.stage-zoomable` with a CSS transform on
  // THIS device only. Nothing here is sent to the server, so one student
  // zooming to 175% has zero effect on the teacher's board or on any other
  // student's view.

  let zoom = 1;
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2.5;
  const stage = el('stageZoomable');

  function applyZoom() {
    stage.style.transform = `scale(${zoom})`;
    el('zoomLevel').textContent = Math.round(zoom * 100) + '%';
  }

  el('zoomIn').addEventListener('click', () => { zoom = Math.min(ZOOM_MAX, zoom + 0.15); applyZoom(); });
  el('zoomOut').addEventListener('click', () => { zoom = Math.max(ZOOM_MIN, zoom - 0.15); applyZoom(); });
  el('zoomReset').addEventListener('click', () => { zoom = 1; applyZoom(); });

  function fitToScreen() {
    const stageWidth = el('viewerStage').clientWidth - 32;
    const contentWidth = stage.scrollWidth || 900;
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stageWidth / contentWidth));
    applyZoom();
  }
  el('zoomFit').addEventListener('click', fitToScreen);
  window.addEventListener('resize', () => { /* user-controlled from here — no auto re-fit to avoid surprising jumps */ });

  // ------------------------------ fullscreen ------------------------------
  const fsBtn = el('fullscreenBtn');
  if (fsBtn) {
    fsBtn.addEventListener('click', function () {
      if (!document.fullscreenElement) {
        (el('viewer').requestFullscreen || function () {}).call(el('viewer'));
      } else {
        document.exitFullscreen();
      }
    });
    document.addEventListener('fullscreenchange', function () {
      fsBtn.textContent = document.fullscreenElement ? '⤢' : '⛶';
      fsBtn.title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
    });
  }

  // ------------------------------ hand raise ------------------------------
  const handBtn = el('handRaiseBtn');
  let handRaised = false;
  if (handBtn) {
    handBtn.addEventListener('click', function () {
      handRaised = !handRaised;
      handBtn.classList.toggle('raised', handRaised);
      if (socket) socket.emit('student:raiseHand', { raised: handRaised });
    });
  }

  // ------------------------------ keystroke overlay ------------------------------
  function showKeyChip(label) {
    const overlay = el('keyOverlay');
    if (!overlay || !label) return;
    const chip = document.createElement('span');
    chip.className = 'key-chip';
    chip.textContent = label;
    overlay.appendChild(chip);
    setTimeout(() => chip.remove(), 1400);
  }

  // ------------------------------ live preview (received) ------------------------------
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

  let previewOn = false;
  function updateStudentPreview() {
    if (!previewOn) return;
    const frame = el('studentPreviewFrame');
    if (frame) frame.srcdoc = buildPreviewHtml(lastCodeState.language, lastCodeState.content);
  }

  function applyPreview(enabled) {
    previewOn = !!enabled;
    const panel = el('studentPreviewPanel');
    if (panel) panel.classList.toggle('hidden', !previewOn);
    if (previewOn) updateStudentPreview();
  }
})();
