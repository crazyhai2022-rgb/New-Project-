/**
 * In-memory session store.
 *
 * A live class is entirely represented by one object in this Map. When the
 * teacher ends the class (or it times out with no teacher connected), the
 * entry is deleted. Nothing here is written to disk — restarting the server
 * clears every live class, which is fine for the MVP (see README for the
 * upgrade path to persistence).
 */

const sessions = new Map(); // code -> session object

function makeSession({ code, teacherName, subject, className, topic }) {
  return {
    code,
    teacherName,
    subject,
    className,
    topic,
    teacherSocketId: null,
    teacherKey: null,      // anonymous per-browser id, used to look up this class in history later
    dbClassId: null,       // Postgres row id, if persistence is configured
    createdAt: Date.now(),
    locked: false,
    paused: false,
    ended: false,

    // The single "currently active" tab the students are looking at.
    mode: 'code', // 'code' | 'notes' | 'whiteboard'

    board: {
      code: { language: 'c', content: '' },
      notes: { content: '' },
      whiteboard: { strokes: [] }, // committed strokes; undo/redo replace this array wholesale
    },

    // studentId -> { name, joinedAt, leftAt, socketId }
    students: new Map(),

    // A short history of mode-content snapshots, used to assemble the
    // generated notes at the end of class without needing a database.
    history: [],
  };
}

function create(fields) {
  sessions.set(fields.code, makeSession(fields));
  return sessions.get(fields.code);
}

function get(code) {
  return sessions.get(code) || null;
}

function remove(code) {
  sessions.delete(code);
}

function all() {
  return [...sessions.values()];
}

module.exports = { create, get, remove, all };
