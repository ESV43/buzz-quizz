/* Team terminal — hardened connect + retryable buzz + 3-2-1 countdown. */
const socket = io({
  // polling-first connects instantly behind mobile middleboxes / captive
  // portals; websocket-first was hanging ~9s before fallback ("huge buffering").
  transports: ['polling', 'websocket'],
  upgrade: true,
  rememberUpgrade: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
  timeout: 15000,
});
const $ = (id) => document.getElementById(id);
let team = null, roomCode = null, clockOffset = 0, rtt = 0;
let armed = false, questionNo = 0, myBuzz = null, buzzLock = false;
let audioCtx = null, syncing = false, lastCount = 0, mineToken = 0, editingName = false;
let pendingBuzz = null; // { buzzId, clientPressTime, tries } — retried, never stuck
let countdown = null;   // { questionNo, endsAt } while 3-2-1 runs
let countdownTimer = null;

const params = new URLSearchParams(location.search);
if (params.get('room')) $('roomInput').value = params.get('room').toUpperCase();
try { $('roomInput').value ||= localStorage.getItem('buzz-room') || ''; $('nameInput').value ||= localStorage.getItem('buzz-name') || ''; } catch {}

function toast(m) { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2400); }
/* ---- screen wake: shared hardened layer (WakeLock + looping video) ----
 * window.BuzzWake (js/wake.js) holds BOTH layers at all times, reclaims every
 * 8s + on every gesture/return. Nothing is ever asked of the player during
 * the event. WakeLock needs https; on plain-LAN http the video layer is what
 * keeps the display alive — use the https link when you have it. */
const wakeApi = () => (window.BuzzWake ? window.BuzzWake.hasApi() : ('wakeLock' in navigator));
function wakeMode() { return window.BuzzWake ? window.BuzzWake.mode() : (wakeApi() ? 'pending' : 'none'); }
function keepAwake() { try { window.BuzzWake?.keepAwake(); } catch {} paintWake(); }
function kickVideo() { try { window.BuzzWake?.kickVideo(); } catch {} }
function startSleepVideo() { try { window.BuzzWake?.ensureVideo(); window.BuzzWake?.kickVideo(); } catch {} }
let lastWakeMode = null, wakeReportT = 0;
/* Report stay-awake state to the host roster (throttled): the host can see
 * exactly which terminals are unprotected instead of discovering it mid-quiz. */
function reportWake(force) {
  if (!team || !socket.connected) return;
  const m = wakeMode();
  const now = Date.now();
  if (!force && m === lastWakeMode && now - wakeReportT < 15000) return;
  lastWakeMode = m; wakeReportT = now;
  try { socket.emit('wake-status', { mode: m, releases: window.BuzzWake?.releases | 0 }); } catch {}
}
function paintWake() {
  const el = $('wakePill');
  const m = wakeMode();
  if (el) {
    if (m === 'lock' || m === 'video') { el.textContent = 'AWAKE'; el.style.color = 'var(--go)'; }
    else if (m === 'none') { el.textContent = 'AT RISK'; el.style.color = 'var(--gold)'; }
    else { el.textContent = '…'; el.style.color = ''; }
  }
  const hint = $('wakeHint');
  if (hint) hint.style.display = (m === 'none' || m === 'pending') ? 'block' : 'none';
  // Loud fallback: when neither layer holds, a full-width tap target. The tap
  // itself is user activation, so it unblocks play() where timers cannot.
  const bn = $('wakeBanner');
  if (bn) bn.style.display = (m === 'none' || m === 'pending') ? 'block' : 'none';
  reportWake(false);
}
try { window.BuzzWake?.onChange(() => paintWake()); } catch {}
try {
  const _wb = $('wakeBanner');
  if (_wb) _wb.onclick = () => { keepAwake(); kickVideo(); setTimeout(paintWake, 600); };
} catch {}
setInterval(paintWake, 5000);
function makeBuzzId() {
  try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch {}
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
/* countdown overlay (created if the HTML template predates it) */
function ensureCountdownOverlay() {
  if ($('countOverlay')) return;
  const d = document.createElement('div');
  d.id = 'countOverlay';
  d.innerHTML = '<div class="count-num" id="countNum">3</div><div class="count-sub" id="countSub">GET READY</div>';
  document.body.appendChild(d);
}
/* server-clock-corrected now: endsAt lives on the server clock, so remaining
   must subtract the measured offset — otherwise ticks flip early/late and the
   big number looks like it stutters. */
function nowServer() { return Date.now() + (clockOffset || 0); }
/* +60ms grace: absorbs server setTimeout drift + socket transit so the digit
   flips within ~1 frame of the server tick echo instead of ahead of it. */
function tickFromRemain(remainMs) { return Math.max(1, Math.ceil((Math.max(0, remainMs) + 60) / 1000)); }
function startCountdownTicker() {
  if (countdownTimer) return;
  countdownTimer = setInterval(() => {
    if (!countdown) { clearInterval(countdownTimer); countdownTimer = null; return; }
    const r = Math.max(0, countdown.endsAt - nowServer());
    if (r <= 0) { hideCountdown(); return; }
    const c = Math.min(3, tickFromRemain(r));
    const n = $('countNum');
    if (n && n.textContent !== String(c)) showCountdown(c, countdown.questionNo);
  }, 100);
}
function showCountdown(count, q) {
  ensureCountdownOverlay();
  // De-dupe: room-update + buzz-update + control-event can deliver the same
  // tick 2-3x — re-popping + re-beeping each time is what looked jittery.
  const key = `${count}:${q ?? ''}`;
  if (showCountdown._key === key && $('countOverlay')?.classList.contains('show')) return;
  showCountdown._key = key;
  const ov = $('countOverlay');
  ov.classList.add('show');
  const n = $('countNum');
  if (n) n.textContent = String(count);
  const sub = $('countSub');
  if (sub) sub.textContent = q ? `QUESTION ${q} — BUZZERS OPEN IN` : 'GET READY';
  // pop animation each tick
  if (n) { n.classList.remove('pop'); void n.offsetWidth; n.classList.add('pop'); }
  clickSound();
}
function hideCountdown() {
  const ov = $('countOverlay');
  if (ov) ov.classList.remove('show');
  showCountdown._key = null;
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  countdown = null;
}
function syncCountdownFromState(state) {
  const cd = state?.countdown;
  if (cd?.active) {
    // New question counting down: any queued press from the old question is stale.
    pendingBuzz = null; myBuzz = null;
    countdown = { questionNo: cd.questionNo, endsAt: cd.endsAt };
    // Derive current tick from server clock so a rejoin mid-countdown lands right.
    const remainMs = Math.max(0, (cd.endsAt || nowServer()) - nowServer());
    const count = Math.min(3, tickFromRemain(remainMs));
    armed = false;
    showCountdown(count, cd.questionNo);
    paintState();
    startCountdownTicker();
  } else if (countdown) {
    hideCountdown();
  }
}
let lastAway = false;
function reportFocus() {
  const away = document.hidden;
  if (away === lastAway) return;
  lastAway = away;
  if (team && socket.connected) socket.emit('focus-status', { away });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake(); syncClock();
    if (!socket.connected) socket.connect();
    // returning from another app: socket may be stale even if `connected`
    // looks alive — throttled silent rejoin restores live arm/buzz state.
    if (team && roomCode && socket.connected) rejoin(true);
  }
  reportFocus();
});
window.addEventListener('blur', () => { if (team && !lastAway) { lastAway = true; if (socket.connected) socket.emit('focus-status', { away: true }); } });
window.addEventListener('focus', () => { keepAwake(); if (team && lastAway) { lastAway = false; if (socket.connected) socket.emit('focus-status', { away: false }); } });
window.addEventListener('online', () => { try { socket.connect(); } catch {} if (team && roomCode) setTimeout(() => rejoin(true), 600); });
window.addEventListener('offline', () => { $('connBar').classList.add('show'); $('connBar').textContent = 'OFFLINE — CHECK WIFI / DATA, RETRYING'; });
$('joinBtn').addEventListener('click', () => keepAwake(), { once: true });

/* light background clock sync — never blocks join or press */
const SYNC_N = 3;
async function syncSample() {
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), 900);
    try {
      socket.timeout(900).emit('time-sync', { t0 }, (err, r) => { clearTimeout(to); resolve(err ? null : r); });
    } catch { clearTimeout(to); resolve(null); }
  });
  if (!res) return null;
  const t3 = Date.now();
  return { off: res.serverTime - (t0 + t3) / 2, rtt: t3 - t0 };
}
async function syncClock() {
  if (!socket.connected || syncing || document.hidden) return;
  syncing = true;
  try {
    const samples = [];
    for (let i = 0; i < SYNC_N; i++) { const s = await syncSample(); if (s) samples.push(s); }
    if (!samples.length) return;
    samples.sort((a, b) => a.rtt - b.rtt);
    const best = samples.slice(0, Math.max(2, Math.ceil(samples.length / 2)));
    const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    clockOffset = med(best.map((s) => s.off));
    rtt = Math.round(med(best.map((s) => s.rtt)));
    $('netPill').textContent = `±${Math.round(rtt / 2)}`;
    if (team && socket.connected) socket.emit('update-netstats', { offset: Math.round(clockOffset), rtt });
  } finally { syncing = false; }
}
socket.on('connect', () => {
  syncClock();
  keepAwake();
  if ($('connBar').classList.contains('show') && navigator.onLine !== false) {
    $('connBar').classList.remove('show');
    $('connBar').textContent = 'CONNECTION LOST — RECONNECTING';
    toast('Reconnected');
  }
  // socket may have died while the tab was backgrounded — reclaim the same
  // team (no duplicate) and pull fresh state so arm/buzzes are current.
  if (team && roomCode) {
    rejoin(true);
    // A press whose ack was lost in the flap: resend same id + press time.
    if (pendingBuzz && !myBuzz) setTimeout(() => retryPendingBuzz('reconnect'), 800);
  }
});
socket.on('disconnect', () => { $('connBar').classList.add('show'); toast('Connection lost — reconnecting'); });
(function scheduleSync() {
  setTimeout(() => { if (team) syncClock(); scheduleSync(); }, 20000 + Math.random() * 8000);
})();

/* join — teamId reattach means refresh/return never duplicates the team */
function storedTeamId() { try { return localStorage.getItem('buzz-team-id') || null; } catch { return null; } }
/* silent rejoin: reclaim the same team + fresh state (never blocks buzzing) */
function rejoin(silent) {
  if (!team || !roomCode || !socket.connected) return;
  const now = Date.now();
  if (silent && now - (rejoin._last || 0) < 3000) return;
  rejoin._last = now;
  socket.emit('join-as-player', {
    code: roomCode, teamName: team.name, teamId: team.id,
    offset: Math.round(clockOffset), rtt,
  }, (res) => {
    if (!res?.ok) {
      // room gone or team kicked while away — drop back to check-in
      team = null; myBuzz = null; pendingBuzz = null;
      try { localStorage.removeItem('buzz-team-id'); } catch {}
      $('playView').style.display = 'none'; $('joinView').style.display = 'block';
      $('joinErr').textContent = res?.error || 'Session lost — join again.';
      return;
    }
    team = res.team; lastAway = false;
    try { localStorage.setItem('buzz-name', team.name); } catch {}
    applyTeam();
    reportWake(true);
    if (res.state) {
      // restore own placement even mid-question (onRoomUpdate only does this on Q change)
      myBuzz = (res.state.buzzes || []).find((b) => b.teamId === team.id) || null;
      if (myBuzz) pendingBuzz = null;
      onRoomUpdate({ teams: [], state: res.state });
      if (myBuzz) renderMine();
      else if (pendingBuzz) retryPendingBuzz('rejoin-state');
    }
    if (!silent) toast(`Checked in as ${team.name}`);
  });
}
$('joinBtn').onclick = () => {
  keepAwake(); startSleepVideo(); // inside the tap gesture: both layers may claim here
  roomCode = $('roomInput').value.trim().toUpperCase();
  const teamName = $('nameInput').value.trim() || 'Team';
  if (roomCode.length < 4) return $('joinErr').textContent = 'Enter the 5-letter code from the host display.';
  if (!socket.connected) { try { socket.connect(); } catch {} }
  $('joinBtn').disabled = true;
  const attempt = (retried = false) => {
    socket.timeout(8000).emit('join-as-player', { code: roomCode, teamName, teamId: storedTeamId(), offset: Math.round(clockOffset), rtt }, (err, res) => {
      if (err && !retried) {
        // join emit timed out (flaky link) — one retry before surfacing
        toast('Slow link — retrying join');
        return attempt(true);
      }
      $('joinBtn').disabled = false;
      if (err || !res?.ok) { $('joinErr').textContent = res?.error || 'Join failed — check code and connection, then retry.'; return; }
      team = res.team; lastAway = false;
      pendingBuzz = null; myBuzz = null; hideCountdown();
      try { localStorage.setItem('buzz-room', roomCode); localStorage.setItem('buzz-name', team.name); localStorage.setItem('buzz-team-id', team.id); } catch {}
      $('joinView').style.display = 'none'; $('playView').style.display = 'block';
      $('roomTag').textContent = roomCode.split('').join(' ');
      applyTeam(); syncClock(); keepAwake();
      if (res.state) {
        myBuzz = (res.state.buzzes || []).find((b) => b.teamId === team.id) || null;
        onRoomUpdate({ teams: [], state: res.state });
        if (myBuzz) renderMine();
      }
      toast(`Checked in as ${team.name}`);
    });
  };
  attempt(false);
};

function applyTeam() {
  if (!editingName) $('teamName').textContent = team.name;
  $('teamChip').style.background = team.color;
  $('buzzBtn').style.setProperty('--team', team.color);
  $('dial').style.setProperty('--team', team.color);
  $('teamGlow').style.background = `radial-gradient(560px 260px at 50% 0%, ${team.color}1f, transparent 70%)`;
}

$('renameBtn').onclick = () => {
  if (editingName || !team) return;
  editingName = true;
  const h = $('teamName');
  const inp = document.createElement('input');
  inp.className = 'nameedit';
  inp.value = team.name;
  inp.maxLength = 24;
  inp.setAttribute('aria-label', 'Team name');
  h.replaceWith(inp);
  inp.focus(); inp.select();
  let finished = false;
  const done = (save) => {
    if (finished) return;
    finished = true; editingName = false;
    const v = inp.value.trim().slice(0, 24);
    inp.replaceWith(h);
    if (save && v && v !== team.name) {
      socket.emit('rename-team', { name: v }, (res) => {
        if (!res?.ok) return toast(res?.error || 'Rename failed');
        team.name = res.name;
        try { localStorage.setItem('buzz-name', res.name); } catch {}
        applyTeam(); toast('Team name updated');
      });
    } else applyTeam();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    else if (e.key === 'Escape') done(false);
  });
  inp.addEventListener('blur', () => done(true));
};

/* dial — optimistic press, same-frame feedback, retryable ack */
const btn = $('buzzBtn'), dial = $('dial');
function readout(cls, pos, sub) {
  const r = $('readout');
  r.className = 'readout ' + cls;
  $('status').textContent = pos;
  $('rankLine').textContent = sub;
}
function triggerGlow() {
  // visible click glow: same-frame feedback even before server confirms.
  // Timeout matches the .hit animation length so the handoff back to the
  // idle pulse is seamless.
  btn.classList.remove('hit'); dial.classList.remove('hit');
  void btn.offsetWidth;
  btn.classList.add('hit'); dial.classList.add('hit');
  clearTimeout(triggerGlow._h);
  triggerGlow._h = setTimeout(() => { btn.classList.remove('hit'); dial.classList.remove('hit'); }, 700);
}
function setSending(sub) {
  btn.classList.add('pressed', 'sending');
  btn.textContent = '···';
  readout('st-placed', 'SENT', sub || 'CONFIRMING WITH HOST');
}
function clearSending() {
  btn.classList.remove('sending', 'pressed');
  buzzLock = false;
  paintState();
}
function sendBuzzAttempt(payload, done) {
  // Timeout-based emit: a lost ack resolves (retry) instead of hanging the dial.
  try {
    socket.timeout(5000).emit('buzz', payload, (err, res) => done(err, res));
  } catch (e) {
    done(e || new Error('emit failed'), null);
  }
}
function resolveBuzzAck(err, res) {
  if (!pendingBuzz) return;
  if (!err && res?.ok) {
    pendingBuzz = null;
    myBuzz = { rank: res.rank, deltaMs: res.deltaMs };
    clearSending();
    renderMine();
    return;
  }
  const msg = res?.error || (err ? 'Slow link' : 'Send failed');
  // Non-retryable states resolve immediately — never leave the dial spinning.
  if (!err && res && (res.error === 'Get ready' || res.error === 'Already buzzed for this question')) {
    pendingBuzz = null;
    clearSending();
    if (res.error === 'Get ready') toast('Hold — countdown running');
    else paintState();
    return;
  }
  if (!err && res && res.error === 'Buzzer is locked') {
    pendingBuzz = null;
    clearSending();
    if (res.error) toast(res.error);
    return;
  }
  // Retryable (timeout / flap / offline): keep one pending press, show state.
  if (!socket.connected || err) {
    readout('st-placed', 'QUEUED', 'LINK LOST — WILL RETRY');
    toast('Link lost — press queued, retrying');
    return;
  }
  // Server error we don't understand: release the dial so the user can press again.
  pendingBuzz = null;
  clearSending();
  if (msg) toast(msg);
}
function retryPendingBuzz(why) {
  if (!pendingBuzz || myBuzz || !team || !socket.connected) return;
  if (countdown || !armed) return; // countdown/lock wins — drop stale queue
  pendingBuzz.tries = (pendingBuzz.tries || 0) + 1;
  if (pendingBuzz.tries > 4) {
    pendingBuzz = null;
    clearSending();
    toast('Could not reach host — press again');
    return;
  }
  setSending(`RETRY ${pendingBuzz.tries} — CONFIRMING`);
  sendBuzzAttempt({
    clientPressTime: pendingBuzz.clientPressTime,
    offset: Math.round(clockOffset), rtt, buzzId: pendingBuzz.buzzId,
  }, resolveBuzzAck);
}
function pressBuzz(e) {
  if (e?.cancelable) e.preventDefault();
  if (!team || buzzLock || myBuzz) return;
  if (countdown) {
    btn.classList.remove('shake'); void btn.offsetWidth; btn.classList.add('shake');
    readout('st-idle', 'READY', 'COUNTDOWN — HOLD');
    try { navigator.vibrate?.(15); } catch {}
    return;
  }
  if (!armed) {
    btn.classList.remove('shake'); void btn.offsetWidth; btn.classList.add('shake');
    readout('st-idle', 'LOCKED', questionNo ? `Q${questionNo} CLOSED — WAIT FOR HOST` : 'WAITING FOR HOST');
    try { navigator.vibrate?.(15); } catch {}
    return;
  }
  if (!socket.connected) {
    toast('Reconnecting — press will queue on link restore');
    try { socket.connect(); } catch {}
  }
  buzzLock = true;
  const clientPressTime = Date.now();
  const buzzId = makeBuzzId();
  pendingBuzz = { buzzId, clientPressTime, tries: 0 };
  setSending();
  ripple();
  triggerGlow();
  try { navigator.vibrate?.(25); } catch {}
  clickSound();
  sendBuzzAttempt({ clientPressTime, offset: Math.round(clockOffset), rtt, buzzId }, resolveBuzzAck);
  // Safety: never leave the dial spinning if the ack path goes silent.
  setTimeout(() => {
    if (pendingBuzz && !myBuzz && btn.classList.contains('sending')) {
      if (!socket.connected) { readout('st-placed', 'QUEUED', 'LINK LOST — WILL RETRY'); buzzLock = false; }
      else retryPendingBuzz('ack-timeout');
    } else if (!pendingBuzz) {
      buzzLock = false;
    }
  }, 5500);
}
function edgeGo() {
  const f = $('edgeFlash'); if (!f) return;
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
}
function ord(n) {
  const s = ['TH', 'ST', 'ND', 'RD'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function ripple() {
  try {
    const r = document.createElement('span');
    r.className = 'ripple';
    btn.appendChild(r);
    setTimeout(() => r.remove(), 500);
  } catch {}
}
btn.addEventListener('pointerdown', pressBuzz);
btn.addEventListener('keydown', (e) => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); pressBuzz(e); } });

function ac() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch { return null; }
}
function clickSound() {
  const ctx = ac(); if (!ctx) return;
  try {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = 660;
    g.gain.setValueAtTime(0.16, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.13);
  } catch {}
}
function fanfare() {
  try { navigator.vibrate?.([60, 50, 100]); } catch {}
  clickSound(); setTimeout(clickSound, 130);
}

socket.on('room-update', onRoomUpdate);
socket.on('buzz-update', (d) => {
  questionNo = d.questionNo ?? questionNo;
  const wasCountdown = !!countdown;
  syncCountdownFromState(d);
  armed = countdown ? false : !!d.armed;
  lastCount = (d.buzzes || []).length;
  const mine = (d.buzzes || []).find((b) => b.teamId === team?.id);
  const prevRank = myBuzz?.rank;
  if (mine) {
    myBuzz = { rank: mine.rank, deltaMs: mine.deltaMs };
    pendingBuzz = null;
    if (!wasCountdown || !countdown) clearSendingSilent();
  } else if (!countdown && d.questionNo !== questionNo) {
    // handled in onRoomUpdate path
  }
  paintState();
  renderMini(d.buzzes || []);
  if (mine && mine.rank !== prevRank) renderMine();
});
function clearSendingSilent() { btn.classList.remove('sending', 'pressed'); buzzLock = false; }
socket.on('control-event', (d) => {
  if (d?.questionNo) {
    if (d.questionNo !== questionNo) { questionNo = d.questionNo; myBuzz = null; pendingBuzz = null; }
    else if (d.action === 'arm' || d.action === 'countdown') { /* same-Q re-arm keeps it simple: clear */ }
  }
  if (d?.action === 'countdown') {
    const c = Math.max(1, Math.min(3, d.count || 3));
    myBuzz = null; pendingBuzz = null;
    armed = false;
    countdown = { questionNo: d.questionNo || questionNo, endsAt: d.endsAt || (nowServer() + c * 1000) };
    if (d.questionNo) questionNo = d.questionNo;
    showCountdown(c, questionNo);
    paintState();
    startCountdownTicker();
    return;
  }
  if (d?.action === 'arm') {
    hideCountdown();
    myBuzz = null; pendingBuzz = null;
    paintState(); edgeGo(); toast(d?.via === 'countdown' ? 'Buzzers live' : 'Buzzers live'); fanfare();
  }
  if (d?.action === 'lock') { hideCountdown(); pendingBuzz = null; toast('Locked by host'); paintState(); }
  if (d?.action === 'reset') { hideCountdown(); myBuzz = null; pendingBuzz = null; paintState(); }
});
socket.on('kicked', (d) => { if (d.teamId === team?.id) { toast('Removed by host'); setTimeout(() => location.reload(), 1200); } });
/* Host closed the room: drop out immediately — no auto-rejoin attempts. */
socket.on('room-closed', (d) => {
  if (d?.code && roomCode && d.code !== roomCode) return;
  team = null; myBuzz = null; pendingBuzz = null; roomCode = null;
  try { hideCountdown(); } catch {}
  try { localStorage.removeItem('buzz-team-id'); } catch {}
  try {
    $('playView').style.display = 'none'; $('joinView').style.display = 'block';
    $('joinErr').textContent = 'Host closed the room — ask the host for a new code.';
  } catch {}
  toast('Room closed by host');
});

function onRoomUpdate({ state }) {
  if (!state) return;
  const wasArmed = armed;
  syncCountdownFromState(state);
  armed = countdown ? false : !!state.armed;
  questionNo = state.questionNo || questionNo;
  if (state.questionNo && $('qPill').dataset.q != String(state.questionNo)) {
    $('qPill').dataset.q = String(state.questionNo);
    myBuzz = (state.buzzes || []).find((b) => b.teamId === team?.id) || null;
    if (myBuzz) pendingBuzz = null;
  }
  lastCount = (state.buzzes || []).length;
  if (state.armed && !wasArmed && !countdown) { myBuzz = myBuzz; edgeGo(); }
  paintState();
  renderMini(state.buzzes || []);
  if (myBuzz) renderMine();
}
function setBtnMode(mode) {
  // Swap only the state class — wiping className here used to kill the
  // in-flight hit/shake/sending/pressed visuals on every room-update.
  if (mode === 'armed') { btn.classList.remove('locked'); btn.classList.add('armed'); }
  else { btn.classList.remove('armed'); btn.classList.add('locked'); }
}
function paintState() {
  $('qPill').textContent = questionNo ? 'Q' + questionNo : '–';
  if (countdown) {
    $('stateTag').textContent = 'Ready';
    $('stateTag').style.color = 'var(--gold)';
    dial.classList.remove('armed');
    btn.classList.remove('sending');
    if (!pendingBuzz) {
      btn.textContent = 'READY'; setBtnMode('locked');
      readout('st-idle', 'READY', `Q${questionNo} STARTS — HOLD`);
    }
    return;
  }
  $('stateTag').textContent = armed ? 'Live' : 'Locked';
  $('stateTag').style.color = armed ? 'var(--go)' : '';
  dial.classList.toggle('armed', armed && !myBuzz);
  if (!pendingBuzz) btn.classList.remove('sending');
  if (!armed) {
    btn.textContent = 'WAIT'; setBtnMode('locked');
    readout('st-idle', 'LOCKED', questionNo ? `Q${questionNo} CLOSED — WAIT FOR HOST` : 'WAITING FOR HOST');
  } else if (myBuzz) {
    btn.textContent = 'P' + myBuzz.rank; setBtnMode('armed');
  } else {
    btn.textContent = pendingBuzz ? '···' : 'BUZZ'; setBtnMode('armed');
    if (!pendingBuzz) readout('st-live', 'LIVE', 'BOTH PLAYERS MAY PRESS');
  }
}
function renderMine() {
  if (!myBuzz) return;
  if (myBuzz.rank === 1) { fanfare(); triggerGlow(); }
  paintState();
  // placement reveal: ordinal + field size + eased margin count-up.
  // Writes are throttled to changed strings only — per-frame DOM writes made
  // the readout shimmer.
  const r = myBuzz.rank, dest = myBuzz.deltaMs;
  const total = Math.max(lastCount, r);
  const title = r === 1 ? 'FIRST' : ord(r);
  const tk = ++mineToken;
  const t0 = performance.now(), dur = 550;
  let lastSub = null;
  readout('st-placed', title, 'CONFIRMING PLACE');
  (function frame(t) {
    if (tk !== mineToken) return;
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    const mg = r === 1 ? '+0' : '+' + Math.round(dest * e);
    const sub = r === 1 ? `1ST OF ${total} — PRESS CONFIRMED` : `${ord(r)} OF ${total} · ${mg} MS`;
    if (sub !== lastSub) { lastSub = sub; readout('st-placed', title, sub); }
    if (p < 1) requestAnimationFrame(frame);
  })(t0);
}
function renderMini(buzzes) {
  const box = $('miniRanks');
  if (!buzzes.length) {
    const h = '<p class="note">No presses recorded.</p>';
    if (box._last !== h) { box._last = h; box.innerHTML = h; }
    return;
  }
  const html = buzzes.slice(0, 8).map((b) =>
    `<div class="orow"><span class="mono">P${b.rank}</span><span class="tchip" style="background:${b.color}"></span>`
    + `<span>${escapeHtml(b.teamName)}</span><span class="mono">+${b.deltaMs}</span>`
    + `${b.teamId === team?.id ? '<span class="you">YOU</span>' : ''}</div>`).join('');
  if (box._last !== html) { box._last = html; box.innerHTML = html; }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
ensureCountdownOverlay();
keepAwake(); // hold the lock from the check-in screen, not just after join
startSleepVideo(); // autoplay attempt (muted+inline); the Join tap guarantees it
paintWake();
