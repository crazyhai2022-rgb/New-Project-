require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const apiRoutes = require('./routes/api');
const { attachClassSocket } = require('./socket/classSocket');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '10mb' })); // generous enough for a whiteboard PNG snapshot
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', apiRoutes);

// Clean URLs for the join flow: /join/ABC123 serves the student page, which
// reads the code out of the URL itself.
app.get('/join/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'student.html'));
});

app.get('/teach/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'teacher.html'));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*' },
});

attachClassSocket(io);

server.listen(PORT, () => {
  console.log(`LiveClass Board listening on port ${PORT}`);
});
