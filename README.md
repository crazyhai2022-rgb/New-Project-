# LiveClass Board

**Teacher Writes Once. Every Student Sees It Live.**

A live digital classroom board. The teacher writes code, notes, or draws on a
whiteboard from their laptop; every connected student sees it update in real
time on their own phone or laptop — no app install, no browser extension.

This is **not** a video-conferencing tool. Nobody's face or screen is shared —
only the teacher's board content, synced instantly to everyone watching.

---

## ⚠️ Read this before deploying to Hostinger

This app needs a **persistent Node.js process that can hold open WebSocket
connections**. That is not the same thing as normal PHP shared hosting, and
it matters for which Hostinger plan you can use it on:

| Hosting type | Will this work? |
|---|---|
| Shared hosting (the plan most `.com` domains use — Premium/Business web hosting) | **No.** These serve PHP/static files per-request and cannot keep a Node process running or hold a WebSocket open. |
| Hostinger **Cloud** or **VPS** plans, or any plan with **Node.js app support** in hPanel | **Yes.** These can run a long-lived Node process. |
| Hostinger's Node.js Selector (available on some Business/Cloud plans) | **Yes**, with the setup below. |

**How to check:** log into hPanel → look for **"Node.js"** under Advanced. If
it's not there, your current plan can't run this — you'd need to upgrade to
a VPS or Cloud plan, or host this piece on a Node-friendly service (Railway,
Render, Fly.io) while keeping your PHP sites on Hostinger as they are.

This isn't a limitation of the code — it's true of *any* real-time app like
this on *any* shared PHP host. I'm telling you now rather than after you've
tried to upload it and wondered why it doesn't run.

---

## What's built

**Phase 1 — core (done):** create class → QR + code + link → student joins →
WebSocket connects → teacher writes → students see it live, with zero page
refresh.

**Phase 2 — teaching tools (done):** code editor with language selector and
syntax highlighting (C, C++, Java, Python, JS, HTML, CSS, SQL), a whiteboard
(draw/erase/undo/redo/clear), a notes tab, three synced modes, live student
list, connection status with auto-reconnect, and **independent per-student
zoom** — one student can view at 175% while another stays at 100%, and
neither affects the teacher's board or each other.

**Phase 3 — notes & PDF (done):** "Generate Notes" compiles whatever was
written into a structured document; "Download PDF" produces a formatted PDF
(PDFKit — pure JavaScript, no headless browser needed) with the class code
block in monospace and, if used, a snapshot of the whiteboard embedded as an
image. Attendance exports as CSV.

**Phase 4 — deliberately out of scope for this version:** teacher accounts,
saved class history, analytics. The spec itself lists these as lowest
priority, and the architecture below can support them later.

## Why no database

The brief asked for the live session to work without one, so a class's
entire state (who's connected, what's on the board, chat-free by design)
lives in server memory for as long as that class is live. Ending the class
clears it. This is intentional simplicity, not a shortcut:

- **Restarting the server** clears every currently-live class. Fine for an
  MVP; the fix later is to persist `sessionStore` to Redis or a database.
- **Multiple server instances** (if you ever scale horizontally) won't share
  session state as written. A single Node process is the assumption here,
  which matches a single small VPS.

Adding persistence later means changing `server/services/sessionStore.js`
to read/write a real store instead of a `Map` — nothing else needs to know
the difference.

## A few practical decisions worth knowing about

- **Code sync sends the full text, debounced to ~220ms**, not a
  character-by-character operational-transform diff. For a classroom-sized
  amount of code this is simpler, has zero merge-conflict risk (only the
  teacher ever writes), and is imperceptible in practice. True OT/CRDT sync
  would matter if students could also type — they can't, by design.
- **Monaco Editor loads from a CDN.** If a school's network blocks it, or it
  loads slowly, the teacher's code tab automatically falls back to a plain
  textarea after 4 seconds — sync keeps working, only the syntax-highlighted
  editor UI is swapped for a simpler one. Nothing breaks.
- **Whiteboard undo/redo replaces the whole stroke list** rather than trying
  to reconcile per-client undo stacks — this guarantees every viewer is
  always pixel-identical to the teacher's board.
- **PDFKit, not Puppeteer**, generates the PDF — shared/VPS hosting often
  can't run a headless Chromium at all, and PDFKit needs nothing extra.

## Project structure

```
server/
  index.js                 Express + Socket.IO entry point
  socket/classSocket.js     all real-time events (teacher + student)
  routes/api.js              REST: create class, check code, PDF, attendance CSV
  services/sessionStore.js   in-memory class state
  services/notes.js          turns board history into a notes structure
  services/pdf.js            PDFKit rendering
  utils/codeGen.js           short, unambiguous session codes (no 0/O/1/I)
public/
  index.html                 create-class landing page
  teacher.html + js/teacher.js + css/teacher.css     teacher dashboard
  student.html + js/student.js + css/student.css     student viewer
  css/style.css               shared design tokens
```

## Local development

Requires Node 18+.

```bash
npm install
cp .env.example .env      # edit PORT if 3000 is taken
npm start
```

Open `http://localhost:3000` to create a class as a teacher. Open the join
link it gives you in another browser (or your phone, if it's on the same
network — use your computer's local IP instead of `localhost`) to join as a
student.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | port the server listens on | `3000` |
| `CORS_ORIGIN` | allowed origin for Socket.IO (set to your real domain in production) | `*` |

## Deploying on a Hostinger VPS / Cloud plan (Node.js supported)

1. **hPanel → Advanced → Node.js** → create a new application.
   - Application root: wherever you upload this project's files
   - Application startup file: `server/index.js`
   - Node version: 18 or newer
2. Set environment variables in that same screen: `PORT` (Hostinger usually
   assigns this for you — use the one it gives), `CORS_ORIGIN` set to
   `https://yourdomain.com`.
3. Run `npm install` from the Node.js app screen's "Run NPM Install" button
   (or via SSH: `cd` into the app folder, `npm install`).
4. **HTTPS/WSS**: once your domain has SSL (hPanel → SSL, usually free via
   Let's Encrypt), Socket.IO automatically upgrades to `wss://` on its own —
   no extra config needed on the client side, since it just connects to
   `io()` against the same origin the page loaded from.
5. Start the app from the Node.js screen. Hostinger keeps it running and
   restarts it if it crashes.
6. Point your domain/subdomain at this Node.js application (hPanel handles
   this as part of the Node.js app setup — it issues an internal proxy from
   your domain to the app's port).

If your specific plan's Node.js Selector proxies through **Apache/LiteSpeed
with mod_proxy**, WebSocket upgrade headers need to pass through — Hostinger's
own Node.js Selector is built to handle this correctly, but if you ever
front this with your own custom reverse proxy config, make sure it forwards
the `Upgrade` and `Connection` headers, or WebSocket connections will
silently fail to upgrade and fall back to slow HTTP polling.

## Deploying elsewhere (Railway / Render / Fly.io / any VPS)

Any host that runs `npm install && npm start` and exposes one port works
identically — none of the code is Hostinger-specific. This is the simplest
path if your Hostinger plan turns out not to support Node.js apps.

## Testing this yourself

1. Open the site, create a class.
2. Open the join link in an incognito window (simulating a student's own
   device) and join with a name.
3. Type in the teacher's Code tab — watch it appear on the student window
   within a fraction of a second.
4. On the student window, click **+** a few times — only that window's zoom
   changes.
5. Switch to Whiteboard on the teacher side and draw — it appears on the
   student side too.
6. Click **Generate Notes** then **Download PDF** on the teacher dashboard.
7. Click **End Class** — the student window shows "Class has ended."
