const { nanoid } = require('nanoid');
const sessionStore = require('../services/sessionStore');
const persistence = require('../services/persistence');

const VALID_MODES = ['code', 'notes', 'whiteboard'];
const VALID_LANGUAGES = ['c', 'cpp', 'java', 'python', 'javascript', 'html', 'css', 'sql'];

function clean(str, max = 200) {
  return String(str || '').trim().slice(0, max);
}

function studentSummary(session) {
  return [...session.students.values()]
    .filter((s) => !s.leftAt)
    .map((s) => ({ id: s.id, name: s.name, joinedAt: s.joinedAt }));
}

function broadcastStudentList(io, session) {
  const list = studentSummary(session);
  io.to(roomFor(session.code)).emit('students:update', { count: list.length, list });
}

function roomFor(code) {
  return `class:${code}`;
}

/**
 * Every socket is tagged with exactly one role for exactly one session,
 * decided server-side at join time. A student socket can never later claim
 * to be a teacher — every handler re-checks `socket.data.role` before
 * accepting a teacher-only command, so a forged client message can't move
 * the board.
 */
function attachClassSocket(io) {
  io.on('connection', (socket) => {
    socket.data.role = null;
    socket.data.sessionCode = null;
    socket.data.studentId = null;

    // ------------------------------------------------------------ teacher
    socket.on('teacher:attach', ({ code } = {}, ack) => {
      const session = sessionStore.get(String(code || '').toUpperCase());
      if (!session || session.ended) return ack?.({ ok: false, error: 'Class not found.' });

      // A teacher reconnecting (e.g. page refresh) replaces the previous
      // teacher socket for this session rather than being treated as a
      // second teacher.
      session.teacherSocketId = socket.id;
      socket.data.role = 'teacher';
      socket.data.sessionCode = session.code;
      socket.join(roomFor(session.code));

      ack?.({
        ok: true,
        session: {
          code: session.code,
          subject: session.subject,
          className: session.className,
          topic: session.topic,
          mode: session.mode,
          board: session.board,
          locked: session.locked,
          paused: session.paused,
        },
        students: studentSummary(session),
      });
    });

    socket.on('teacher:setMode', ({ mode } = {}) => {
      if (socket.data.role !== 'teacher') return;
      const session = sessionStore.get(socket.data.sessionCode);
      if (!session || !VALID_MODES.includes(mode)) return;

      session.mode = mode;
      io.to(roomFor(session.code)).emit('mode:changed', { mode });
    });

    socket.on('teacher:updateCode', ({ language, content } = {}) => {
      if (socket.data.role !== 'teacher') return;
      const session = sessionStore.get(socket.data.sessionCode);
      if (!session) return;

      const lang = VALID_LANGUAGES.includes(language) ? language : session.board.code.language;
      session.board.code = { language: lang, content: String(content ?? '').slice(0, 200000) };

      socket.to(roomFor(session.code)).emit('board:code', session.board.code);
      touchHistory(session, 'code');
    });

    socket.on('teacher:updateNotes', ({ content } = {}) => {
      if (socket.data.role !== 'teacher') return;
      const session = sessionStore.get(socket.data.sessionCode);
      if (!session) return;

      session.board.notes = { content: String(content ?? '').slice(0, 200000) };
      socket.to(roomFor(session.code)).emit('board:notes', session.board.notes);
      touchHistory(session, 'notes');
    });

    // Whiteboard: the teacher's canvas commits a finished stroke and sends
    // its points once (not per pixel), keeping traffic light.
    socket.on('teacher:whiteboardStroke', (stroke = {}) => {
      if (socket.data.role !== 'teacher') return;
      const session = sessionStore.get(socket.data.sessionCode);
      if (!session) return;
      if (!Array.isArray(stroke.points) || stroke.points.length < 2) return;

      const safeStroke = {
        id: nanoid(8),
        color: /^#[0-9a-f]{3,6}$/i.test(stroke.color) ? stroke.color : '#1a2840',
        width: Math.min(Math.max(Number(stroke.width) || 3, 1), 40),
        erase: !!stroke.erase,
        points: stroke.points.slice(0, 2000).map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]),
      };
      session.board.whiteboard.strokes.push(safeStroke);
      socket.to(roomFor(session.code)).emit('board:whiteboardStroke', safeStroke);
      touchHistory(session, 'whiteboard');
    });

    socket.on('teacher:whiteboardClear', () => {
      if (socket.data.role !== 'teacher') return;
      const session = sessionStore.get(socket.data.sessionCode);
      if (!session) return;
      session.board.whiteboard.strokes = [];
      io.to(roomFor(session.code)).emit('board:whiteboardReplace', { strokes: [] });
    });

    // Undo/redo: the teacher keeps its own redo stack client-side and simply
    // asks the server to replace the authoritative stroke list — this keeps
    // every client in perfect sync without reimplementing undo logic twice.
    socket.on('teacher:whiteboardReplace', ({ strokes } = {}) => {
      if (socket.data.role !== 'teacher') return;
      const session = sessionStore.get(socket.data.sessionCode);
      if (!session || !Array.isArray(strokes)) return;
      session.board.whiteboard.strokes = strokes.slice(0, 5000);
      socket.to(roomFor(session.code)).emit('board:whiteboardReplace', { strokes: session.board.whiteboard.strokes });
    });

    socket.on('teacher:pause', () => withTeacherSession(socket, (session) => {
      session.paused = true;
      io.to(roomFor(session.code)).emit('session:paused');
    }));

    socket.on('teacher:resume', () => withTeacherSession(socket, (session) => {
      session.paused = false;
      io.to(roomFor(session.code)).emit('session:resumed');
    }));

    socket.on('teacher:lock', ({ locked } = {}) => withTeacherSession(socket, (session) => {
      session.locked = !!locked;
    }));

    socket.on('teacher:end', () => withTeacherSession(socket, (session) => {
      session.ended = true;
      io.to(roomFor(session.code)).emit('session:ended');
      io.socketsLeave(roomFor(session.code));
      persistence.recordClassEnd(session.dbClassId); // fire-and-forget — the class is already over for everyone regardless
      sessionStore.remove(session.code);
    }));

    // ------------------------------------------------------------ student
    socket.on('student:join', ({ code, studentName } = {}, ack) => {
      const session = sessionStore.get(String(code || '').toUpperCase());
      if (!session || session.ended) return ack?.({ ok: false, error: 'Class not found.' });
      if (session.locked) return ack?.({ ok: false, error: 'This class is locked. Ask the teacher to let new students in.' });

      const name = clean(studentName, 40);
      if (!name) return ack?.({ ok: false, error: 'Please enter your name.' });

      const id = nanoid(10);
      session.students.set(id, { id, name, joinedAt: Date.now(), leftAt: null, socketId: socket.id, dbAttendanceId: null });

      socket.data.role = 'student';
      socket.data.sessionCode = session.code;
      socket.data.studentId = id;
      socket.join(roomFor(session.code));

      ack?.({
        ok: true,
        studentId: id,
        session: {
          subject: session.subject,
          className: session.className,
          topic: session.topic,
          teacherName: session.teacherName,
          mode: session.mode,
          board: session.board, // full current state — a late joiner is never shown a blank board
          paused: session.paused,
        },
      });

      broadcastStudentList(io, session);

      // Best-effort — attendance still shows in the live roster and CSV
      // export even if this write fails or persistence isn't configured.
      persistence.recordStudentJoin(session.dbClassId, name).then((rowId) => {
        const student = session.students.get(id);
        if (student) student.dbAttendanceId = rowId;
      });
    });

    socket.on('disconnect', () => {
      if (socket.data.role !== 'student' || !socket.data.sessionCode) return;
      const session = sessionStore.get(socket.data.sessionCode);
      if (!session) return;

      const student = session.students.get(socket.data.studentId);
      if (student) {
        student.leftAt = Date.now();
        persistence.recordStudentLeave(student.dbAttendanceId);
      }
      broadcastStudentList(io, session);
    });
  });
}

function withTeacherSession(socket, fn) {
  if (socket.data.role !== 'teacher') return;
  const session = sessionStore.get(socket.data.sessionCode);
  if (session) fn(session);
}

function touchHistory(session, mode) {
  session.history.push({ mode, at: Date.now() });
  if (session.history.length > 500) session.history.shift();
}

module.exports = { attachClassSocket };
