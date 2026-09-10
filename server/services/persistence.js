/**
 * Persistence layer, backed by Supabase (Postgres).
 *
 * This is entirely optional. The live classroom itself runs on server
 * memory (see services/sessionStore.js) exactly as before — nothing here
 * is on the critical path for a class to work. If Supabase isn't
 * configured, every function below quietly no-ops so the app still runs
 * exactly like the original DB-free MVP.
 *
 * What gets saved:
 *  - `classes`         one row per class, created when the teacher starts
 *                       it and marked ended when they finish
 *  - `class_snapshots` a copy of the board content whenever the teacher
 *                       generates notes/PDF (and once more at class end)
 *  - `attendance`       each student's join/leave time
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const enabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

let client = null;
if (enabled) {
  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
} else {
  console.warn(
    '[persistence] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — ' +
    'classes will work normally but nothing will be saved for history. ' +
    'See README.md to connect Supabase.'
  );
}

function isEnabled() {
  return enabled;
}

/** Called when a class is created. Returns the new row's id, or null if persistence is off. */
async function recordClassStart({ code, subject, className, topic, teacherName, teacherKey }) {
  if (!enabled) return null;
  const { data, error } = await client
    .from('classes')
    .insert({ code, subject, class_name: className || null, topic: topic || null, teacher_name: teacherName, teacher_key: teacherKey })
    .select('id')
    .single();
  if (error) { console.error('[persistence] recordClassStart failed:', error.message); return null; }
  return data.id;
}

async function recordClassEnd(classId) {
  if (!enabled || !classId) return;
  const { error } = await client.from('classes').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', classId);
  if (error) console.error('[persistence] recordClassEnd failed:', error.message);
}

async function recordStudentJoin(classId, studentName) {
  if (!enabled || !classId) return null;
  const { data, error } = await client
    .from('attendance')
    .insert({ class_id: classId, student_name: studentName })
    .select('id')
    .single();
  if (error) { console.error('[persistence] recordStudentJoin failed:', error.message); return null; }
  return data.id;
}

async function recordStudentLeave(attendanceRowId) {
  if (!enabled || !attendanceRowId) return;
  const { error } = await client.from('attendance').update({ left_at: new Date().toISOString() }).eq('id', attendanceRowId);
  if (error) console.error('[persistence] recordStudentLeave failed:', error.message);
}

/**
 * Uploads a base64 PNG (the whiteboard canvas snapshot) to private storage
 * and returns a long-lived signed URL for the teacher's own history page.
 */
async function uploadWhiteboardImage(classId, base64Png) {
  if (!enabled || !base64Png) return null;
  const buffer = Buffer.from(base64Png.replace(/^data:image\/png;base64,/, ''), 'base64');
  const path = `${classId}/${Date.now()}.png`;

  const { error: upErr } = await client.storage.from('whiteboard-snapshots').upload(path, buffer, { contentType: 'image/png' });
  if (upErr) { console.error('[persistence] whiteboard upload failed:', upErr.message); return null; }

  const { data, error } = await client.storage.from('whiteboard-snapshots').createSignedUrl(path, 60 * 60 * 24 * 365);
  if (error) { console.error('[persistence] whiteboard signed URL failed:', error.message); return null; }
  return data.signedUrl;
}

/** Uploads the generated notes PDF and returns a signed URL. */
async function uploadNotesPdf(classId, pdfBuffer) {
  if (!enabled || !pdfBuffer) return null;
  const path = `${classId}/${Date.now()}.pdf`;

  const { error: upErr } = await client.storage.from('notes-pdfs').upload(path, pdfBuffer, { contentType: 'application/pdf' });
  if (upErr) { console.error('[persistence] pdf upload failed:', upErr.message); return null; }

  const { data, error } = await client.storage.from('notes-pdfs').createSignedUrl(path, 60 * 60 * 24 * 365);
  if (error) { console.error('[persistence] pdf signed URL failed:', error.message); return null; }
  return data.signedUrl;
}

async function recordSnapshot(classId, { language, codeContent, notesContent, whiteboardImageUrl, pdfUrl }) {
  if (!enabled || !classId) return;
  const { error } = await client.from('class_snapshots').insert({
    class_id: classId,
    code_language: language || null,
    code_content: codeContent || null,
    notes_content: notesContent || null,
    whiteboard_image_url: whiteboardImageUrl || null,
    pdf_url: pdfUrl || null,
  });
  if (error) console.error('[persistence] recordSnapshot failed:', error.message);
}

/** Past classes for one anonymous teacher identity, newest first. */
async function getHistoryForTeacher(teacherKey) {
  if (!enabled) return [];
  const { data, error } = await client
    .from('classes')
    .select('id, code, subject, class_name, topic, status, started_at, ended_at, class_snapshots(id, pdf_url, whiteboard_image_url, created_at)')
    .eq('teacher_key', teacherKey)
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) { console.error('[persistence] getHistoryForTeacher failed:', error.message); return []; }
  return data;
}

module.exports = {
  isEnabled,
  recordClassStart,
  recordClassEnd,
  recordStudentJoin,
  recordStudentLeave,
  uploadWhiteboardImage,
  uploadNotesPdf,
  recordSnapshot,
  getHistoryForTeacher,
};
