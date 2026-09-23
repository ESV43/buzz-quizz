/**
 * BUZZ ARENA — server (v2)
 * Rooms + latency-compensated buzz ranking + PIN-locked companion remote.
 * Join links / QR automatically use the public URL:
 *   1. PUBLIC_URL env var if set (e.g. https://buzz-theta-ashy.vercel.app)
 *   2. otherwise the Host header of the creating socket, when it is public
 *      (works on Vercel / Render / any hosted deploy with zero config)
 *   3. otherwise the host's LAN addresses (local-network play)
 */
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- helpers ----------
const TEAM_COLORS = [
  '#E5484D', '#F76B15', '#FFB224', '#46A758', '#12A594', '#0090FF',
  '#6550B9', '#B975F1', '#E93DAE', '#E8B34B', '#D6409F', '#70E1C8',
  '#8ECAFF', '#FF977D', '#D3A6FF', '#9DFFA0', '#FFC53D', '#5CE08A',
  '#7C8AFF', '#FF6B6B',
];
const rand = (n) => Math.floor(Math.random() * n);
function makeRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[rand(chars.length)];
  return s;
}
function makePin(digits = 4) {
  let s = '';
  for (let i = 0; i < digits; i++) s += String(rand(10));
  return s;
}
function localIPs() {
  const out = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}
function isPublicHost(host) {
  if (!host) return false;
  const h = String(host).split(':')[0].toLowerCase();
  if (h === 'localhost') return false;
  if (/^127\./.test(h)) return false;
  if (/^10\./.test(h)) return false;
  if (/^192\.168\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}
/** Base URL players should open, derived per-socket so Vercel needs no config. */
function publicBase(socket) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = socket?.handshake?.headers?.host;
  if (isPublicHost(host)) {
    const proto = socket.handshake.headers['x-forwarded-proto'] || 'https';
    return `${proto}://${host}`;
  }
  return null;
}
function joinLinks(socket, code) {
  const urls = [];
  const base = publicBase(socket);
  if (base) urls.push(`${base}/play.html?room=${code}`);
  for (const ip of localIPs()) urls.push(`http://${ip}:${PORT}/play.html?room=${code}`);
  if (!urls.length) urls.push(`http://localhost:${PORT}/play.html?room=${code}`);
  return urls;
}

// roomCode -> room
const rooms = new Map();

function publicTeams(room) {
  return [...room.teams.values()].map((t) => ({
    id: t.id, name: t.name, color: t.color,
    connected: t.connected, rtt: t.rtt ?? null, offset: t.offset ?? null,
  }));
}
function publicState(room) {
  return {
    armed: room.state.armed,
    questionNo: room.state.questionNo,
    buzzes: room.state.buzzes,
    teamCount: room.teams.size,
  };
}
function broadcastRoom(room) {
  io.to(room.code).emit('room-update', { teams: publicTeams(room), state: publicState(room) });
}
function rankBuzzes(room) {
  room.state.buzzes.sort((a, b) => a.adjustedTime - b.adjustedTime);
  const w = room.state.buzzes[0];
  room.state.buzzes.forEach((b, i) => {
    b.rank = i + 1;
    b.deltaMs = w ? Math.max(0, Math.round(b.adjustedTime - w.adjustedTime)) : 0;
  });
}

io.on('connection', (socket) => {
  socket.on('time-sync', (msg, cb) => {
    if (typeof cb === 'function') cb({ t0: msg?.t0 ?? null, serverTime: Date.now() });
  });

  // ---- HOST: create room ----
  socket.on('create-room', async (opts, cb) => {
    const code = makeRoomCode();
    const companionPin = makePin(4);
    const room = {
      code, createdAt: Date.now(),
      maxTeams: Math.min(Math.max(parseInt(opts?.maxTeams, 10) || 20, 8), 20),
      hostId: socket.id, companionIds: new Set(), companionPin,
      failedAttempts: new Map(),
      teams: new Map(), socketToTeam: new Map(),
      state: { armed: false, questionNo: 0, buzzes: [] },
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.role = 'host';
    socket.data.roomCode = code;
    const base = publicBase(socket);
    const joinUrls = joinLinks(socket, code);
    const companionUrl = base ? `${base}/companion.html` : null;
    let qr = null;
    try { qr = await QRCode.toDataURL(joinUrls[0]); } catch { /* ignore */ }
    cb?.({
      ok: true, code, companionPin, joinUrls, companionUrl, qr,
      state: publicState(room), teams: publicTeams(room),
    });
    broadcastRoom(room);
  });

  // ---- HOST: reclaim after refresh ----
  socket.on('host-rejoin', ({ code }, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    room.hostId = socket.id;
    socket.join(room.code);
    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    cb?.({
      ok: true, companionPin: room.companionPin,
      joinUrls: joinLinks(socket, room.code),
      state: publicState(room), teams: publicTeams(room),
    });
    broadcastRoom(room);
  });

  // ---- PLAYER: join ----
  socket.on('join-as-player', ({ code, teamName, offset, rtt }, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: 'Room code not found. Check with the host.' });
    if (room.teams.size >= room.maxTeams && !room.socketToTeam.has(socket.id)) {
      return cb?.({ ok: false, error: `Room full (${room.maxTeams} teams).` });
    }
    let teamId = room.socketToTeam.get(socket.id);
    let team;
    if (teamId && room.teams.has(teamId)) {
      team = room.teams.get(teamId);
      team.connected = true;
      team.socketId = socket.id;
      if (typeof teamName === 'string' && teamName.trim()) team.name = teamName.trim().slice(0, 24);
    } else {
      teamId = 'T' + Math.random().toString(36).slice(2, 7).toUpperCase();
      team = {
        id: teamId,
        name: (typeof teamName === 'string' && teamName.trim()) ? teamName.trim().slice(0, 24) : `Team ${room.teams.size + 1}`,
        color: TEAM_COLORS[room.teams.size % TEAM_COLORS.length],
        socketId: socket.id, connected: true,
        rtt: rtt ?? null, offset: offset ?? null, lastSeen: Date.now(),
      };
      room.teams.set(teamId, team);
      room.socketToTeam.set(socket.id, teamId);
    }
    if (typeof offset === 'number') team.offset = offset;
    if (typeof rtt === 'number') team.rtt = rtt;
    socket.join(code);
    socket.data.role = 'player';
    socket.data.roomCode = code;
    socket.data.teamId = teamId;
    cb?.({ ok: true, team: { id: team.id, name: team.name, color: team.color }, state: publicState(room) });
    broadcastRoom(room);
  });

  socket.on('update-netstats', ({ offset, rtt }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'player') return;
    const team = room.teams.get(socket.data.teamId);
    if (!team) return;
    if (typeof offset === 'number') team.offset = Math.round(offset);
    if (typeof rtt === 'number') team.rtt = Math.round(rtt);
    socket.to(room.code).emit('netstats', { teamId: team.id, rtt: team.rtt, offset: team.offset });
  });

  socket.on('rename-team', ({ name }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false });
    const team = room.teams.get(socket.data.teamId);
    if (!team) return cb?.({ ok: false });
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) return cb?.({ ok: false, error: 'Name cannot be empty' });
    team.name = clean;
    cb?.({ ok: true, name: clean });
    broadcastRoom(room);
  });

  // ---- BUZZ: latency-compensated ----
  socket.on('buzz', ({ clientPressTime, offset, rtt }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: 'No room' });
    if (socket.data.role !== 'player') return cb?.({ ok: false, error: 'Only players can buzz' });
    if (!room.state.armed) return cb?.({ ok: false, error: 'Buzzer is locked' });
    const team = room.teams.get(socket.data.teamId);
    if (!team) return cb?.({ ok: false });
    if (room.state.buzzes.some((b) => b.teamId === team.id)) {
      return cb?.({ ok: false, error: 'Already buzzed for this question' });
    }
    const serverReceiveTime = Date.now();
    const safeOffset = typeof offset === 'number' && Math.abs(offset) < 60000 ? offset : (team.offset || 0);
    const press = typeof clientPressTime === 'number' ? clientPressTime : serverReceiveTime;
    const adjustedTime = press + safeOffset;
    if (typeof rtt === 'number') team.rtt = Math.round(rtt);
    team.offset = Math.round(safeOffset);
    room.state.buzzes.push({
      teamId: team.id, teamName: team.name, color: team.color,
      clientPressTime: press, offset: Math.round(safeOffset),
      serverReceiveTime, adjustedTime: Math.round(adjustedTime),
      rtt: team.rtt, rank: null, deltaMs: null,
    });
    rankBuzzes(room);
    const mine = room.state.buzzes.find((b) => b.teamId === team.id);
    cb?.({ ok: true, rank: mine.rank, deltaMs: mine.deltaMs });
    io.to(room.code).emit('buzz-update', {
      buzzes: room.state.buzzes, armed: room.state.armed, questionNo: room.state.questionNo,
    });
    broadcastRoom(room);
  });

  // ---- HOST + COMPANION controls ----
  function requireControl() {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return { ok: false, error: 'No room joined' };
    if (socket.data.role === 'host' && room.hostId === socket.id) return { ok: true, room };
    if (socket.data.role === 'companion' && room.companionIds.has(socket.id)) return { ok: true, room };
    return { ok: false, error: 'Not authorized' };
  }

  function doControl(action, room, extra = {}) {
    if (action === 'arm') {
      if (extra.increment !== false) room.state.questionNo += 1;
      if (room.state.questionNo < 1) room.state.questionNo = 1;
      room.state.buzzes = [];
      room.state.armed = true;
      room.state.armedAt = Date.now();
    } else if (action === 'lock') {
      room.state.armed = false;
      room.state.lockedAt = Date.now();
    } else if (action === 'reset') {
      room.state.buzzes = [];
      room.state.armed = false;
    } else if (action === 'next') {
      room.state.questionNo += 1;
      room.state.buzzes = [];
      room.state.armed = true;
      room.state.armedAt = Date.now();
    } else if (action === 'clear') {
      room.state.buzzes = [];
    }
  }

  socket.on('host-control', ({ action, ...extra }, cb) => {
    const gate = requireControl();
    if (!gate.ok) return cb?.(gate);
    const room = gate.room;
    if (socket.data.role === 'companion' && !['arm', 'lock', 'reset', 'next', 'clear'].includes(action)) {
      return cb?.({ ok: false, error: 'Companions can only arm / lock / reset.' });
    }
    doControl(action, room, extra);
    cb?.({ ok: true, state: publicState(room) });
    broadcastRoom(room);
    io.to(room.code).emit('buzz-update', { buzzes: room.state.buzzes, armed: room.state.armed, questionNo: room.state.questionNo });
    io.to(room.code).emit('control-event', { action, questionNo: room.state.questionNo });
  });

  socket.on('kick-team', ({ teamId }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host' || room.hostId !== socket.id) return cb?.({ ok: false });
    if (!room.teams.has(teamId)) return cb?.({ ok: false });
    room.teams.delete(teamId);
    for (const [sid, tid] of [...room.socketToTeam.entries()]) if (tid === teamId) room.socketToTeam.delete(sid);
    room.state.buzzes = room.state.buzzes.filter((b) => b.teamId !== teamId);
    rankBuzzes(room);
    cb?.({ ok: true });
    io.to(room.code).emit('kicked', { teamId });
    broadcastRoom(room);
  });

  // ---- COMPANION: join with PIN, rate-limited ----
  socket.on('join-as-companion', ({ code, pin }, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: 'Room not found' });
    const ip = socket.handshake.address || 'unknown';
    const now = Date.now();
    const rec = room.failedAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    if (now < rec.lockedUntil) {
      const s = Math.ceil((rec.lockedUntil - now) / 1000);
      return cb?.({ ok: false, error: `Too many wrong PINs. Try again in ${s}s.` });
    }
    if (String(pin) !== String(room.companionPin)) {
      rec.count += 1;
      if (rec.count >= 3) {
        rec.lockedUntil = now + 30_000;
        rec.count = 0;
        room.failedAttempts.set(ip, rec);
        io.to(room.code).emit('security-alert', { msg: `Blocked companion attempt from ${ip} (3 wrong PINs)` });
        return cb?.({ ok: false, error: 'Too many wrong PINs. Locked 30s. Host was notified.' });
      }
      room.failedAttempts.set(ip, rec);
      return cb?.({ ok: false, error: `Wrong companion PIN (${3 - rec.count} tries left). Ask the host.` });
    }
    room.failedAttempts.delete(ip);
    room.companionIds.add(socket.id);
    socket.join(code);
    socket.data.role = 'companion';
    socket.data.roomCode = code;
    cb?.({ ok: true, state: publicState(room), teams: publicTeams(room) });
    io.to(room.code).emit('security-alert', { msg: 'Companion controller connected' });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data?.roomCode);
    if (!room) return;
    if (socket.data.role === 'player' && socket.data.teamId) {
      const team = room.teams.get(socket.data.teamId);
      if (team && team.socketId === socket.id) {
        team.connected = false;
        broadcastRoom(room);
      }
    }
    if (socket.data.role === 'companion') room.companionIds.delete(socket.id);
  });
});

// prune stale rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 1000 * 60 * 60 * 4 && room.teams.size === 0) rooms.delete(code);
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`\n  BUZZ ARENA live on :${PORT}`);
  if (PUBLIC_URL) console.log(`  Public URL: ${PUBLIC_URL}`);
  for (const ip of localIPs()) console.log(`  LAN: http://${ip}:${PORT}`);
});
