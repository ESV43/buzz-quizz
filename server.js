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
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Hardened transport: polling-first connects fast behind captive portals /
// mobile middleboxes (websocket-first hangs ~9s before fallback, seen as
// "huge buffering"), then upgrades. Longer ping timeout survives brief
// mobile radio gaps without dropping the room; state recovery bridges
// short disconnects so a press ack lost in a flap can still be recovered.
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['polling', 'websocket'],
  pingInterval: 15000,
  pingTimeout: 30000,
  upgradeTimeout: 15000,
  maxHttpBufferSize: 1e6,
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: true },
});
// Keep idle sockets alive behind proxies/LBs (must exceed their 60s idle cut).
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

app.use(express.static(path.join(__dirname, 'public'), {
  // Phones cache aggressively: HTML must revalidate every load so terminals
  // always boot the current JS (old cached pages silently miss fixes).
  // Versioned assets (?v=) stay cache-friendly; socket.io path unaffected.
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
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
/** Direct-access companion links (room pre-filled) — LAN fallback included. */
function companionLinks(socket, code) {
  const urls = [];
  const base = publicBase(socket);
  if (base) urls.push(`${base}/companion.html?room=${code}`);
  for (const ip of localIPs()) urls.push(`http://${ip}:${PORT}/companion.html?room=${code}`);
  if (!urls.length) urls.push(`http://localhost:${PORT}/companion.html?room=${code}`);
  return urls;
}

// roomCode -> room
const rooms = new Map();

// ---- room persistence: survive server restarts (file-backed) ----
// Socket/grants are ephemeral; teams + standings + PIN are durable.
// On boot everyone rejoins silently: host via host-rejoin, teams by teamId.
const DATA_FILE = path.join(__dirname, 'rooms.json');
let saveTimer = null;
function queueSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveRooms(); }, 500);
}
function saveRooms() {
  try {
    const data = [...rooms.values()].map((room) => ({
      code: room.code,
      createdAt: room.createdAt,
      lastActivity: room.lastActivity,
      maxTeams: room.maxTeams,
      companionPin: room.companionPin,
      questionNo: room.state.questionNo,
      buzzes: room.state.buzzes,
      teams: [...room.teams.values()].map((t) => ({
        id: t.id, name: t.name, color: t.color,
        rtt: t.rtt ?? null, offset: t.offset ?? null,
        away: !!t.away, lastSeen: t.lastSeen || Date.now(),
      })),
    }));
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: Date.now(), rooms: data }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('room save failed:', e.message); }
}
function loadRooms() {
  let raw;
  try { raw = fs.readFileSync(DATA_FILE, 'utf8'); } catch { return; }
  try {
    const data = JSON.parse(raw);
    for (const r of data.rooms || []) {
      if (!r.code || rooms.has(r.code)) continue;
      const room = {
        code: r.code, createdAt: r.createdAt || Date.now(),
        lastActivity: r.lastActivity || Date.now(),
        maxTeams: r.maxTeams || 20, hostId: null, companionIds: new Set(),
        companionPin: r.companionPin || makePin(4), failedAttempts: new Map(),
        teams: new Map(), socketToTeam: new Map(),
        pendingDisconnect: new Map(), countdownTimers: [],
        // In-flight countdowns can't resume across a restart — restore locked
        // on the same question with standings intact; host re-arms (3-2-1).
        state: {
          armed: false, questionNo: r.questionNo || 0,
          buzzes: Array.isArray(r.buzzes) ? r.buzzes : [], countdown: null,
        },
      };
      for (const t of r.teams || []) {
        if (!t.id) continue;
        room.teams.set(t.id, {
          id: t.id, name: String(t.name || 'Team').slice(0, 24),
          color: t.color || '#888', socketId: null,
          connected: false, away: !!t.away,
          rtt: t.rtt ?? null, offset: t.offset ?? null,
          lastSeen: t.lastSeen || Date.now(),
        });
      }
      rooms.set(room.code, room);
    }
    if (rooms.size) console.log(`  Restored ${rooms.size} room(s) from disk`);
  } catch (e) { console.error('room load failed:', e.message); }
}

function publicTeams(room) {
  return [...room.teams.values()].map((t) => ({
    id: t.id, name: t.name, color: t.color,
    connected: t.connected, away: !!t.away, rtt: t.rtt ?? null, offset: t.offset ?? null,
    wake: t.wake?.mode || null, // lock | video | pending | none — stay-awake state
  }));
}
function publicState(room) {
  return {
    armed: room.state.armed,
    questionNo: room.state.questionNo,
    buzzes: room.state.buzzes,
    teamCount: room.teams.size,
    // Countdown (3-2-1 after Next) so late/rejoining clients can render it.
    countdown: room.state.countdown || null,
    serverTime: Date.now(),
  };
}
function broadcastRoom(room) {
  io.to(room.code).emit('room-update', { teams: publicTeams(room), state: publicState(room) });
  queueSave(); // every roster/state change is durable within ~0.5s
}
function rankBuzzes(room) {
  room.state.buzzes.sort((a, b) => a.adjustedTime - b.adjustedTime);
  const w = room.state.buzzes[0];
  room.state.buzzes.forEach((b, i) => {
    b.rank = i + 1;
    b.deltaMs = w ? Math.max(0, Math.round(b.adjustedTime - w.adjustedTime)) : 0;
  });
}

// ---- disconnect grace: transient radio gaps (<10s) must not flap the roster ----
const DISCONNECT_GRACE_MS = 10000;
function clearPendingDisconnect(room, teamId) {
  const t = room.pendingDisconnect?.get(teamId);
  if (t) { clearTimeout(t); room.pendingDisconnect.delete(teamId); }
}

// ---- 3-2-1 countdown after Next: server-driven so every terminal stays in sync ----
const COUNTDOWN_STEPS = [3, 2, 1];
const COUNTDOWN_STEP_MS = 1000;
function clearCountdown(room) {
  if (Array.isArray(room.countdownTimers)) {
    for (const t of room.countdownTimers) clearTimeout(t);
  }
  room.countdownTimers = [];
  if (room.state.countdown) room.state.countdown = null;
}
function emitCountdown(room, count) {
  io.to(room.code).emit('control-event', {
    action: 'countdown', questionNo: room.state.questionNo, count,
    endsAt: room.state.countdown?.endsAt ?? null, serverTime: Date.now(),
  });
}
function startCountdown(room, seconds = 3) {
  clearCountdown(room);
  room.state.questionNo += 1;
  if (room.state.questionNo < 1) room.state.questionNo = 1;
  room.state.buzzes = [];
  room.state.armed = false;
  room.state.armedAt = null;
  room.state.countdown = {
    active: true, questionNo: room.state.questionNo,
    endsAt: Date.now() + seconds * COUNTDOWN_STEP_MS,
    serverTime: Date.now(),
  };
  room.lastActivity = Date.now();
  broadcastRoom(room);
  io.to(room.code).emit('buzz-update', {
    buzzes: room.state.buzzes, armed: false, questionNo: room.state.questionNo,
    countdown: room.state.countdown,
  });
  // Tick 3,2,1 then go live. Timers are tracked so lock/reset/next can cancel.
  COUNTDOWN_STEPS.forEach((count, i) => {
    if (i === 0) {
      emitCountdown(room, count);
      return;
    }
    room.countdownTimers.push(setTimeout(() => {
      // Room may have been deleted or countdown cancelled.
      if (!rooms.has(room.code) || !room.state.countdown) return;
      emitCountdown(room, count);
      broadcastRoom(room);
    }, i * COUNTDOWN_STEP_MS));
  });
  room.countdownTimers.push(setTimeout(() => {
    if (!rooms.has(room.code) || !room.state.countdown) return;
    room.state.countdown = null;
    room.state.buzzes = [];
    room.state.armed = true;
    room.state.armedAt = Date.now();
    room.lastActivity = Date.now();
    broadcastRoom(room);
    io.to(room.code).emit('buzz-update', {
      buzzes: room.state.buzzes, armed: true, questionNo: room.state.questionNo,
      countdown: null,
    });
    io.to(room.code).emit('control-event', { action: 'arm', questionNo: room.state.questionNo, via: 'countdown' });
  }, seconds * COUNTDOWN_STEP_MS));
}

io.on('connection', (socket) => {
  socket.on('time-sync', (msg, cb) => {
    if (typeof cb === 'function') cb({ t0: msg?.t0 ?? null, serverTime: Date.now() });
  });

  // ---- HOST: create room ----
  socket.on('create-room', async (opts, cb) => {
    let code = makeRoomCode();
    const wanted = String(opts?.wantedCode || '').toUpperCase().trim();
    if (/^[A-Z0-9]{4,6}$/.test(wanted) && !rooms.has(wanted)) code = wanted;
    const companionPin = makePin(4);
    const room = {
      code, createdAt: Date.now(), lastActivity: Date.now(),
      maxTeams: Math.min(Math.max(parseInt(opts?.maxTeams, 10) || 20, 8), 20),
      hostId: socket.id, companionIds: new Set(), companionPin,
      failedAttempts: new Map(),
      teams: new Map(), socketToTeam: new Map(),
      pendingDisconnect: new Map(), countdownTimers: [],
      state: { armed: false, questionNo: 0, buzzes: [], countdown: null },
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.role = 'host';
    socket.data.roomCode = code;
    const joinUrls = joinLinks(socket, code);
    const compUrls = companionLinks(socket, code);
    const companionUrl = compUrls[0] || null;
    let qr = null, companionQr = null;
    try { qr = await QRCode.toDataURL(joinUrls[0]); } catch { /* ignore */ }
    try { if (companionUrl) companionQr = await QRCode.toDataURL(companionUrl); } catch { /* ignore */ }
    cb?.({
      ok: true, code, companionPin, joinUrls, companionUrl, companionUrls: compUrls, qr, companionQr,
      state: publicState(room), teams: publicTeams(room),
    });
    broadcastRoom(room);
  });

  // ---- HOST: reclaim after refresh ----
  // Returns the same payload as create-room (QRs included) so a refresh
  // restores the full console. If the server restarted, in-memory rooms are
  // gone — the client offers to recreate the same code (see wantedCode).
  socket.on('host-rejoin', async ({ code }, cb) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return cb?.({ ok: false, error: 'Room not found on this server. It may have restarted — recreate the same code.' });
    room.hostId = socket.id;
    socket.join(room.code);
    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    const joinUrls = joinLinks(socket, room.code);
    const compUrls = companionLinks(socket, room.code);
    const companionUrl = compUrls[0] || null;
    let qr = null, companionQr = null;
    try { qr = await QRCode.toDataURL(joinUrls[0]); } catch { /* ignore */ }
    try { if (companionUrl) companionQr = await QRCode.toDataURL(companionUrl); } catch { /* ignore */ }
    cb?.({
      ok: true, code: room.code, companionPin: room.companionPin,
      joinUrls, companionUrl, companionUrls: compUrls, qr, companionQr,
      state: publicState(room), teams: publicTeams(room),
    });
    broadcastRoom(room);
  });

  // ---- PLAYER: join ----
  socket.on('join-as-player', ({ code, teamName, teamId: knownId, offset, rtt }, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: 'Room code not found. Check with the host.' });
    // Reattach path: returning tab / reconnected socket reclaims its old team
    // instead of spawning a duplicate — allowed even when the room is full.
    let teamId = (typeof knownId === 'string' && room.teams.has(knownId)) ? knownId : room.socketToTeam.get(socket.id);
    const isReattach = !!teamId && room.teams.has(teamId);
    if (!isReattach && room.teams.size >= room.maxTeams) {
      return cb?.({ ok: false, error: `Room full (${room.maxTeams} teams).` });
    }
    let team;
    if (isReattach) {
      team = room.teams.get(teamId);
      // drop stale mappings for this team (dead sockets) — last socket wins
      for (const [sid, tid] of [...room.socketToTeam.entries()]) if (tid === teamId && sid !== socket.id) room.socketToTeam.delete(sid);
      room.socketToTeam.set(socket.id, teamId);
      team.connected = true;
      team.away = false; // back in the app — never block buzzing on focus state
      team.socketId = socket.id;
      team.lastSeen = Date.now();
      clearPendingDisconnect(room, teamId);
      if (typeof teamName === 'string' && teamName.trim()) team.name = teamName.trim().slice(0, 24);
    } else {
      teamId = 'T' + Math.random().toString(36).slice(2, 7).toUpperCase();
      team = {
        id: teamId,
        name: (typeof teamName === 'string' && teamName.trim()) ? teamName.trim().slice(0, 24) : `Team ${room.teams.size + 1}`,
        color: TEAM_COLORS[room.teams.size % TEAM_COLORS.length],
        socketId: socket.id, connected: true, away: false,
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

  // ---- SPECTATOR: overlay / projector (OBS Browser Source) ----
  // Read-only: joins the room channel, receives room-update / buzz-update /
  // control-event, never appears in the roster and can never buzz or control.
  socket.on('join-as-spectator', ({ code }, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: 'Room code not found. Check with the host.' });
    socket.join(code);
    socket.data.role = 'spectator';
    socket.data.roomCode = code;
    cb?.({ ok: true, state: publicState(room), teams: publicTeams(room) });
  });

  // ---- PLAYER: stay-awake report (host roster dot, not persisted) ----
  socket.on('wake-status', ({ mode, releases }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'player') return;
    const team = room.teams.get(socket.data.teamId);
    if (!team) return;
    const m = ['lock', 'video', 'pending', 'none'].includes(mode) ? mode : 'pending';
    if (team.wake?.mode === m) return; // releases count is diagnostic noise — don't rebroadcast
    team.wake = { mode: m, releases: releases | 0, at: Date.now() };
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

  // ---- PLAYER: tab / app visibility (anti-wandering) ----
  socket.on('focus-status', ({ away }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'player') return;
    const team = room.teams.get(socket.data.teamId);
    if (!team) return;
    const isAway = !!away;
    if (team.away === isAway) return;
    team.away = isAway;
    team.lastSeen = Date.now();
    io.to(room.code).emit('focus-alert', {
      teamId: team.id, teamName: team.name, away: isAway, at: Date.now(),
    });
    broadcastRoom(room);
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

  // ---- BUZZ: latency-compensated, idempotent across retries ----
  socket.on('buzz', ({ clientPressTime, offset, rtt, buzzId }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, error: 'No room' });
    if (socket.data.role !== 'player') return cb?.({ ok: false, error: 'Only players can buzz' });
    // Countdown running: presses are too early — tell the terminal to hold.
    if (room.state.countdown?.active) {
      return cb?.({ ok: false, error: 'Get ready', retryable: false, countdown: room.state.countdown });
    }
    if (!room.state.armed) return cb?.({ ok: false, error: 'Buzzer is locked' });
    const team = room.teams.get(socket.data.teamId);
    if (!team) return cb?.({ ok: false });
    // Retry safety: the first attempt may have landed while its ack was lost
    // in a flap. Return the existing placement as success instead of an
    // "Already buzzed" error so the terminal resolves instead of spinning.
    const existing = room.state.buzzes.find((b) => b.teamId === team.id);
    if (existing) {
      return cb?.({ ok: true, rank: existing.rank, deltaMs: existing.deltaMs, duplicate: true });
    }
    if (buzzId && room.state.buzzes.some((b) => b.buzzId === buzzId)) {
      const mine = room.state.buzzes.find((b) => b.buzzId === buzzId);
      return cb?.({ ok: true, rank: mine.rank, deltaMs: mine.deltaMs, duplicate: true });
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
      buzzId: typeof buzzId === 'string' ? buzzId.slice(0, 64) : null,
    });
    rankBuzzes(room);
    const mine = room.state.buzzes.find((b) => b.teamId === team.id);
    room.lastActivity = Date.now();
    cb?.({ ok: true, rank: mine.rank, deltaMs: mine.deltaMs });
    io.to(room.code).emit('buzz-update', {
      buzzes: room.state.buzzes, armed: room.state.armed, questionNo: room.state.questionNo,
      countdown: room.state.countdown || null,
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
      // Legacy instant-arm fallback (host-control now routes arm -> countdown).
      // Kept so any direct doControl('arm') call still opens the buzzer.
      clearCountdown(room);
      if (extra.increment !== false) room.state.questionNo += 1;
      if (room.state.questionNo < 1) room.state.questionNo = 1;
      room.state.buzzes = [];
      room.state.armed = true;
      room.state.armedAt = Date.now();
      room.lastActivity = Date.now();
    } else if (action === 'lock') {
      clearCountdown(room);
      room.state.armed = false;
      room.state.lockedAt = Date.now();
      room.lastActivity = Date.now();
    } else if (action === 'reset') {
      clearCountdown(room);
      room.state.buzzes = [];
      room.state.armed = false;
      room.lastActivity = Date.now();
    } else if (action === 'next') {
      // Next question always runs the 3-2-1 countdown, then goes live.
      // Handled in host-control (async timers) — doControl only marks activity.
      room.lastActivity = Date.now();
    } else if (action === 'clear') {
      room.state.buzzes = [];
      room.lastActivity = Date.now();
    }
    // 'present' and 'overlay' are display-only (projector / OBS overlay flip) —
    // no room state, just relayed below so any controller can flip them.
  }

  socket.on('host-control', ({ action, ...extra }, cb) => {
    const gate = requireControl();
    if (!gate.ok) return cb?.(gate);
    const room = gate.room;
    if (socket.data.role === 'companion' && !['arm', 'lock', 'reset', 'next', 'clear', 'present', 'overlay'].includes(action)) {
      return cb?.({ ok: false, error: 'Companions can only arm / lock / reset / present / overlay.' });
    }
    if (action === 'next' || action === 'arm') {
      // Server-driven 3-2-1: bump Q, hold locked, tick, then auto-arm.
      // Both Arm and Next run the countdown (Arm is no longer instant).
      startCountdown(room, 3);
      cb?.({ ok: true, state: publicState(room) });
      return;
    }
    doControl(action, room, extra);
    cb?.({ ok: true, state: publicState(room) });
    broadcastRoom(room);
    io.to(room.code).emit('buzz-update', {
      buzzes: room.state.buzzes, armed: room.state.armed, questionNo: room.state.questionNo,
      countdown: room.state.countdown || null,
    });
    io.to(room.code).emit('control-event', { action, questionNo: room.state.questionNo, on: extra.on ?? null });
  });

  socket.on('kick-team', ({ teamId }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host' || room.hostId !== socket.id) {
      return cb?.({ ok: false, error: 'Host session expired (reconnect?) — reclaim the room and retry.' });
    }
    if (!room.teams.has(teamId)) return cb?.({ ok: false, error: 'Team already gone.' });
    room.teams.delete(teamId);
    for (const [sid, tid] of [...room.socketToTeam.entries()]) if (tid === teamId) room.socketToTeam.delete(sid);
    room.state.buzzes = room.state.buzzes.filter((b) => b.teamId !== teamId);
    rankBuzzes(room);
    cb?.({ ok: true });
    io.to(room.code).emit('kicked', { teamId });
    broadcastRoom(room);
  });

  // ---- HOST: close room — every terminal goes out immediately ----
  // Host-only. Notifies the whole room first (players / companions /
  // spectators all drop to their entry screens), then deletes the room so
  // late rejoin attempts fail with "not found" instead of hanging.
  socket.on('close-room', (_, cb) => {
    const room = rooms.get(socket.data?.roomCode);
    if (!room || socket.data.role !== 'host' || room.hostId !== socket.id) {
      return cb?.({ ok: false, error: 'Host session expired (reconnect?) — reclaim the room and retry.' });
    }
    const code = room.code;
    try { clearCountdown(room); } catch {}
    try {
      for (const [, t] of room.pendingDisconnect || []) clearTimeout(t);
      room.pendingDisconnect?.clear?.();
    } catch {}
    try { io.to(code).emit('room-closed', { code, at: Date.now() }); } catch {}
    try {
      // Force every socket out of the room channel (v4 API; fall back harmlessly).
      if (typeof io.in(code).socketsLeave === 'function') io.in(code).socketsLeave(code);
    } catch {}
    rooms.delete(code);
    queueSave();
    try { socket.data.roomCode = null; } catch {}
    cb?.({ ok: true, code });
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
      // Grace period: a 2-5s radio gap must not flap the roster to OUT.
      // Only mark offline if the team hasn't reattached within the window.
      if (team && team.socketId === socket.id) {
        clearPendingDisconnect(room, socket.data.teamId);
        const teamId = socket.data.teamId;
        room.pendingDisconnect.set(teamId, setTimeout(() => {
          room.pendingDisconnect.delete(teamId);
          const t = room.teams.get(teamId);
          // Still the same dead socket — no reattach happened.
          if (t && t.socketId === socket.id) {
            t.connected = false;
            broadcastRoom(room);
          }
        }, DISCONNECT_GRACE_MS));
      }
    }
    if (socket.data.role === 'companion') room.companionIds.delete(socket.id);
  });
});

// prune stale rooms (keep active event rooms; Vercel-style restarts wipe memory
// anyway — host reclaim + team reattach restore the session)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - (room.lastActivity || room.createdAt);
    const empty = room.teams.size === 0;
    if ((empty && idle > 1000 * 60 * 60 * 4) || idle > 1000 * 60 * 60 * 12) {
      clearCountdown(room);
      rooms.delete(code);
      queueSave();
    }
  }
}, 60_000);

loadRooms();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  BUZZ ARENA live on :${PORT}`);
  if (PUBLIC_URL) console.log(`  Public URL: ${PUBLIC_URL}`);
  for (const ip of localIPs()) console.log(`  LAN: http://${ip}:${PORT}`);
});
