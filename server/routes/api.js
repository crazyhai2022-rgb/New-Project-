const express = require('express');
const { nanoid } = require('nanoid');
const sessionStore = require('../services/sessionStore');
const { generateSessionCode } = require('../utils/codeGen');
const { buildNotes } = require('../services/notes');
const { buildNotesPdfBuffer } = require('../services/pdf');
const persistence = require('../services/persistence');

const router = express.Router();

function clean(str, max = 120) {
  return String(str || '').trim().slice(0, max);
}

/** Teacher creates a class. Returns the session code the QR/link is built from. */
router.post('/classes', async (req, res) => {
  const teacherName = clean(req.body.teacherName, 80) || 'Teacher';
  const subject = clean(req.body.subject, 80) || 'Untitled Subject';
  const className = clean(req.body.className, 80);
  const topic = clean(req.body.topic, 120);

  // An anonymous per-browser id, generated client-side and reused across
  // classes — good enough for "show me my own past classes" without
  // building full accounts. See services/persistence.js for the caveats.
  const teacherKey = clean(req.body.teacherKey, 40) || nanoid(24);

  const code = generateSessionCode((c) => !!sessionStore.get(c));
  const session = sessionStore.create({ code, teacherName, subject, className, topic });
  session.teacherKey = teacherKey;

  session.dbClassId = await persistence.recordClassStart({ code, subject, className, topic, teacherName, teacherKey });

  res.json({
    ok: true,
    code: session.code,
    teacherKey,
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

/** Generates the notes PDF, streams it back, and (if Supabase is configured) saves a copy. */
router.post('/classes/:code/notes.pdf', async (req, res) => {
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

  try {
    const pdfBuffer = await buildNotesPdfBuffer(notesData);
    const filename = `${(session.subject || 'class-notes').replace(/[^a-z0-9]+/gi, '-')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);

    // Saving is best-effort and happens after the response is already on
    // its way — a slow or failed save should never hold up the download.
    if (persistence.isEnabled() && session.dbClassId) {
      const [pdfUrl, whiteboardImageUrl] = await Promise.all([
        persistence.uploadNotesPdf(session.dbClassId, pdfBuffer),
        req.body.whiteboardImage ? persistence.uploadWhiteboardImage(session.dbClassId, req.body.whiteboardImage) : Promise.resolve(null),
      ]);
      await persistence.recordSnapshot(session.dbClassId, {
        language: session.board.code.language,
        codeContent: session.board.code.content,
        notesContent: session.board.notes.content,
        whiteboardImageUrl,
        pdfUrl,
      });
    }
  } catch (err) {
    console.error('[api] PDF generation failed:', err.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Could not generate the PDF.' });
  }
});

/** Attendance as a downloadable CSV — built from in-memory join/leave times. */
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

/** A teacher's own past classes, found via their anonymous browser id. */
router.get('/history/:teacherKey', async (req, res) => {
  if (!persistence.isEnabled()) {
    return res.json({ ok: true, enabled: false, classes: [] });
  }
  const classes = await persistence.getHistoryForTeacher(clean(req.params.teacherKey, 40));
  res.json({ ok: true, enabled: true, classes });
});

module.exports = router;
