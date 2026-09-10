const express = require('express');
const sessionStore = require('../services/sessionStore');
const { generateSessionCode } = require('../utils/codeGen');
const { buildNotes } = require('../services/notes');
const { generateNotesPdf } = require('../services/pdf');

const router = express.Router();

function clean(str, max = 120) {
  return String(str || '').trim().slice(0, max);
}

/** Teacher creates a class. Returns the session code the QR/link is built from. */
router.post('/classes', (req, res) => {
  const teacherName = clean(req.body.teacherName, 80) || 'Teacher';
  const subject = clean(req.body.subject, 80) || 'Untitled Subject';
  const className = clean(req.body.className, 80);
  const topic = clean(req.body.topic, 120);

  const code = generateSessionCode((c) => !!sessionStore.get(c));
  const session = sessionStore.create({ code, teacherName, subject, className, topic });

  res.json({
    ok: true,
    code: session.code,
    joinUrl: `${req.protocol}://${req.get('host')}/join/${session.code}`,
  });
});

/** Students (and rejoining teachers) use this to check a code before opening the socket. */
router.get('/classes/:code', (req, res) => {
  const session = sessionStore.get(req.params.code.toUpperCase());
  if (!session || session.ended) {
    return res.status(404).json({ ok: false, error: 'Class not found. Check the code and try again.' });
  }
  res.json({
    ok: true,
    subject: session.subject,
    className: session.className,
    topic: session.topic,
    teacherName: session.teacherName,
    locked: session.locked,
    paused: session.paused,
    studentCount: session.students.size,
  });
});

/** Generates and streams the notes PDF for a session. */
router.post('/classes/:code/notes.pdf', (req, res) => {
  const session = sessionStore.get(req.params.code.toUpperCase());
  if (!session) return res.status(404).json({ ok: false, error: 'Class not found.' });

  const notesData = buildNotes(session);

  // The whiteboard is rendered client-side; the browser sends a PNG snapshot
  // along with the request so it can be embedded without a headless browser.
  const whiteboardSection = notesData.sections.find((s) => s.type === 'whiteboard');
  if (whiteboardSection && req.body.whiteboardImage) {
    const base64 = req.body.whiteboardImage.replace(/^data:image\/png;base64,/, '');
    whiteboardSection.imageBuffer = Buffer.from(base64, 'base64');
  }

  const filename = `${(session.subject || 'class-notes').replace(/[^a-z0-9]+/gi, '-')}.pdf`;
  generateNotesPdf(notesData, res, filename);
});

/** Attendance as a downloadable CSV — no DB needed, built from in-memory join/leave times. */
router.get('/classes/:code/attendance.csv', (req, res) => {
  const session = sessionStore.get(req.params.code.toUpperCase());
  if (!session) return res.status(404).json({ ok: false, error: 'Class not found.' });

  const rows = [['Student Name', 'Joined At', 'Left At']];
  for (const s of session.students.values()) {
    rows.push([
      s.name,
      new Date(s.joinedAt).toLocaleString('en-IN'),
      s.leftAt ? new Date(s.leftAt).toLocaleString('en-IN') : 'Still connected',
    ]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${session.code}.csv"`);
  res.send(csv);
});

module.exports = router;
