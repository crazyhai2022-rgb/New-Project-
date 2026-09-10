/**
 * Turns a session's board history into an organised notes structure that the
 * PDF generator (and the on-screen preview) can both render.
 *
 * The teacher's session doesn't need a database for this — everything comes
 * from the in-memory `session.history` array, which is appended to whenever
 * the teacher meaningfully changes the board (see socket/classSocket.js).
 */

function buildNotes(session) {
  const sections = [];

  // Group history entries by mode, in the order they first appeared, so
  // the notes read like "what we covered" rather than a raw event log.
  const seen = new Set();
  for (const entry of session.history) {
    if (seen.has(entry.mode)) continue;
    seen.add(entry.mode);
  }

  // Always include whatever is on the board right now, even if the teacher
  // never explicitly "saved" it — that's the point of capturing everything.
  if (session.board.notes.content.trim()) {
    sections.push({
      type: 'notes',
      title: 'Notes',
      content: session.board.notes.content,
    });
  }

  if (session.board.code.content.trim()) {
    sections.push({
      type: 'code',
      title: 'Code',
      language: session.board.code.language,
      content: session.board.code.content,
    });
  }

  if (session.board.whiteboard.strokes.length > 0) {
    sections.push({
      type: 'whiteboard',
      title: 'Whiteboard',
      strokeCount: session.board.whiteboard.strokes.length,
    });
  }

  return {
    subject: session.subject,
    className: session.className,
    topic: session.topic,
    teacherName: session.teacherName,
    date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
    sections,
  };
}

module.exports = { buildNotes };
