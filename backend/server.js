const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// Set FRONTEND_URL on Render to your Vercel URL (no trailing slash).
// Several origins can be comma-separated. Falls back to "*" if unset.
const ALLOWED_ORIGIN = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((s) => s.trim())
  : '*';

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));

app.get('/', (req, res) => res.send('Watch Party server is running.'));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN, methods: ['GET', 'POST'] },
});

// ---------------------------------------------------------------
// Rooms: Map<roomId, { members: [socketId, ...], url, state }>
// members[0] is always the Host. Max 2 members per room.
// ---------------------------------------------------------------
const rooms = new Map();

function currentState(room) {
  const s = room.state;
  const time = s.playing ? s.time + (Date.now() - s.ts) / 1000 : s.time;
  return { time, playing: s.playing };
}

io.on('connection', (socket) => {
  const getRoom = () => rooms.get(socket.data.room);
  const isHost = () => {
    const room = getRoom();
    return room && room.members[0] === socket.id;
  };

  socket.on('join', (roomId) => {
    roomId = String(roomId || '').toLowerCase();
    if (!/^[a-z0-9]{3,20}$/.test(roomId)) return;

    let room = rooms.get(roomId);
    if (!room) {
      room = { members: [], url: '', state: { time: 0, playing: false, ts: Date.now() } };
      rooms.set(roomId, room);
    }
    if (room.members.length >= 2) return socket.emit('room-full');

    room.members.push(socket.id);
    socket.join(roomId);
    socket.data.room = roomId;

    socket.emit('joined', {
      role: room.members[0] === socket.id ? 'host' : 'guest',
      url: room.url,
      state: currentState(room),
    });
    io.to(roomId).emit('peers', room.members.length);
  });

  // Host loads a video link -> everyone else loads it too
  socket.on('load', (url) => {
    if (!isHost() || !/^https?:\/\//i.test(String(url))) return;
    const room = getRoom();
    room.url = String(url);
    room.state = { time: 0, playing: false, ts: Date.now() };
    socket.to(socket.data.room).emit('load', room.url);
  });

  // Host play / pause / seek / heartbeat -> guest
  socket.on('state', (s) => {
    if (!isHost() || !s) return;
    const room = getRoom();
    room.state = { time: Number(s.time) || 0, playing: !!s.playing, ts: Date.now() };
    socket.to(socket.data.room).emit('state', currentState(room));
  });

  // Guest asks for the latest host state
  socket.on('resync', () => {
    const room = getRoom();
    if (room) socket.emit('state', currentState(room));
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.room;
    const room = rooms.get(roomId);
    if (!room) return;

    room.members = room.members.filter((id) => id !== socket.id);
    if (room.members.length === 0) {
      rooms.delete(roomId);
      return;
    }
    // The remaining person becomes Host
    io.to(room.members[0]).emit('role', 'host');
    io.to(roomId).emit('peers', room.members.length);
  });
});

server.listen(PORT, () => console.log(`Watch Party server listening on port ${PORT}`));

// ---------------------------------------------------------------
// Keep-Alive: ping ourselves every 10 minutes so Render's free tier
// doesn't spin down after 15 minutes of inactivity.
// Render sets RENDER_EXTERNAL_URL automatically.
// ---------------------------------------------------------------
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(async () => {
    try {
      const res = await fetch(`${SELF_URL}/health`);
      console.log(`[keep-alive] ${res.status} at ${new Date().toISOString()}`);
    } catch (err) {
      console.error('[keep-alive] failed:', err.message);
    }
  }, 10 * 60 * 1000);
}
