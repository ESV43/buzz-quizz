/* Team terminal. Protocol unchanged. */
const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 400,
  reconnectionDelayMax: 3500,
  timeout: 9000,
});
const $ = (id) => document.getElementById(id);
let team = null, roomCode = null, clockOffset = 0, rtt = 0;
let armed = false, questionNo = 0, myBuzz = null, buzzLock = false;
let audioCtx = null, syncing = false, lastCount = 0, mineToken = 0, editingName = false;

const params = new URLSearchParams(location.search);
if (params.get('room')) $('roomInput').value = params.get('room').toUpperCase();
try { $('roomInput').value ||= localStorage.getItem('buzz-room') || ''; $('nameInput').value ||= localStorage.getItem('buzz-name') || ''; } catch {}

function toast(m) { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2400); }
async function keepAwake() { try { await navigator.wakeLock?.request('screen'); } catch {} }
let lastAway = false;
function reportFocus() {
  const away = document.hidden;
  if (away === lastAway) return;
  lastAway = away;
  if (team) socket.emit('focus-status', { away });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake(); syncClock();
    // returning from another app: socket may be stale even if `connected`
    // looks alive — throttled silent rejoin restores live arm/buzz state.
    if (team && roomCode && socket.connected) rejoin(true);
  }
  reportFocus();
});
window.addEventListener('blur', () => { if (team && !lastAway) { lastAway = true; socket.emit('focus-status', { away: true }); } });
window.addEventListener('focus', () => { if (team && lastAway) { lastAway = false; socket.emit('focus-status', { away: false }); } });
$('joinBtn').addEventListener('click', () => keepAwake(), { once: true });

/* light background clock sync — never blocks join or press */
const SYNC_N = 5;
async function syncSample() {
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), 1200);
    socket.emit('time-sync', { t0 }, (r) => { clearTimeout(to); resolve(r); });
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
    if (team) socket.emit('update-netstats', { offset: Math.round(clockOffset), rtt });
  } finally { syncing = false; }
}
socket.on('connect', () => { syncClock(); });
socket.on('disconnect', () => { $('connBar').classList.add('show'); toast('Connection lost — reconnecting'); });
socket.on('connect', () => {
  if ($('connBar').classList.contains('show')) { $('connBar').classList.remove('show'); toast('Reconnected'); }
  // socket may have died while the tab was backgrounded — reclaim the same
  // team (no duplicate) and pull fresh state so arm/buzzes are current.
  if (team && roomCode) rejoin(true);
});
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
      team = null; myBuzz = null;
      try { localStorage.removeItem('buzz-team-id'); } catch {}
      $('playView').style.display = 'none'; $('joinView').style.display = 'block';
      $('joinErr').textContent = res?.error || 'Session lost — join again.';
      return;
    }
    team = res.team; lastAway = false;
    try { localStorage.setItem('buzz-name', team.name); } catch {}
    applyTeam();
    if (res.state) {
      // restore own placement even mid-question (onRoomUpdate only does this on Q change)
      myBuzz = (res.state.buzzes || []).find((b) => b.teamId === team.id) || null;
      onRoomUpdate({ teams: [], state: res.state });
      if (myBuzz) renderMine();
    }
    if (!silent) toast(`Checked in as ${team.name}`);
  });
}
$('joinBtn').onclick = () => {
  roomCode = $('roomInput').value.trim().toUpperCase();
  const teamName = $('nameInput').value.trim() || 'Team';
  if (roomCode.length < 4) return $('joinErr').textContent = 'Enter the 5-letter code from the host display.';
  $('joinBtn').disabled = true;
  socket.emit('join-as-player', { code: roomCode, teamName, teamId: storedTeamId(), offset: Math.round(clockOffset), rtt }, (res) => {
    $('joinBtn').disabled = false;
    if (!res?.ok) { $('joinErr').textContent = res?.error || 'Join failed'; return; }
    team = res.team; lastAway = false;
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

/* dial — optimistic press, same-frame feedback */
const btn = $('buzzBtn'), dial = $('dial');
function readout(cls, pos, sub) {
  const r = $('readout');
  r.className = 'readout ' + cls;
  $('status').textContent = pos;
  $('rankLine').textContent = sub;
}
function triggerGlow() {
  // visible click glow: same-frame feedback even before server confirms
  btn.classList.remove('hit'); dial.classList.remove('hit');
  void btn.offsetWidth;
  btn.classList.add('hit'); dial.classList.add('hit');
  clearTimeout(triggerGlow._h);
  triggerGlow._h = setTimeout(() => { btn.classList.remove('hit'); dial.classList.remove('hit'); }, 750);
}
function pressBuzz(e) {
  if (e?.cancelable) e.preventDefault();
  if (!team || buzzLock || myBuzz) return;
  if (!armed) {
    btn.classList.remove('shake'); void btn.offsetWidth; btn.classList.add('shake');
    readout('st-idle', 'LOCKED', questionNo ? `Q${questionNo} CLOSED — WAIT FOR HOST` : 'WAITING FOR HOST');
    try { navigator.vibrate?.(15); } catch {}
    return;
  }
  buzzLock = true;
  const clientPressTime = Date.now();
  btn.classList.add('pressed', 'sending');
  btn.textContent = '···';
  readout('st-placed', 'SENT', 'CONFIRMING WITH HOST');
  ripple();
  triggerGlow();
  try { navigator.vibrate?.(25); } catch {}
  clickSound();
  socket.emit('buzz', { clientPressTime, offset: Math.round(clockOffset), rtt }, (res) => {
    btn.classList.remove('sending');
    setTimeout(() => { buzzLock = false; btn.classList.remove('pressed'); }, 250);
    if (!res?.ok) { paintState(); if (res?.error) toast(res.error); return; }
    myBuzz = { rank: res.rank, deltaMs: res.deltaMs };
    renderMine();
  });
  setTimeout(() => { buzzLock = false; btn.classList.remove('pressed', 'sending'); }, 2500);
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
  armed = !!d.armed;
  lastCount = (d.buzzes || []).length;
  const mine = (d.buzzes || []).find((b) => b.teamId === team?.id);
  const prevRank = myBuzz?.rank;
  myBuzz = mine ? { rank: mine.rank, deltaMs: mine.deltaMs } : myBuzz;
  paintState();
  renderMini(d.buzzes || []);
  if (mine && mine.rank !== prevRank) renderMine();
});
socket.on('control-event', (d) => {
  if (d?.questionNo) { questionNo = d.questionNo; myBuzz = null; paintState(); }
  if (d?.action === 'arm') { myBuzz = null; paintState(); edgeGo(); toast('Buzzers live'); fanfare(); }
  if (d?.action === 'lock') toast('Locked by host');
  if (d?.action === 'reset') { myBuzz = null; paintState(); }
});
socket.on('kicked', (d) => { if (d.teamId === team?.id) { toast('Removed by host'); setTimeout(() => location.reload(), 1200); } });

function onRoomUpdate({ state }) {
  if (!state) return;
  const wasArmed = armed;
  armed = !!state.armed; questionNo = state.questionNo || questionNo;
  if (state.questionNo && $('qPill').dataset.q != String(state.questionNo)) {
    $('qPill').dataset.q = String(state.questionNo);
    myBuzz = (state.buzzes || []).find((b) => b.teamId === team?.id) || null;
  }
  lastCount = (state.buzzes || []).length;
  if (state.armed && !wasArmed) { myBuzz = null; edgeGo(); }
  paintState();
  renderMini(state.buzzes || []);
  if (myBuzz) renderMine();
}
function paintState() {
  $('qPill').textContent = questionNo ? 'Q' + questionNo : '–';
  $('stateTag').textContent = armed ? 'Live' : 'Locked';
  $('stateTag').style.color = armed ? 'var(--go)' : '';
  dial.classList.toggle('armed', armed && !myBuzz);
  btn.classList.remove('sending');
  if (!armed) {
    btn.textContent = 'WAIT'; btn.className = 'locked';
    readout('st-idle', 'LOCKED', questionNo ? `Q${questionNo} CLOSED — WAIT FOR HOST` : 'WAITING FOR HOST');
  } else if (myBuzz) {
    btn.textContent = 'P' + myBuzz.rank; btn.className = 'armed';
  } else {
    btn.textContent = 'BUZZ'; btn.className = 'armed';
    readout('st-live', 'LIVE', 'BOTH PLAYERS MAY PRESS');
  }
}
function renderMine() {
  if (!myBuzz) return;
  if (myBuzz.rank === 1) { fanfare(); triggerGlow(); }
  paintState();
  // placement reveal: ordinal + field size + animated margin count-up
  const r = myBuzz.rank, dest = myBuzz.deltaMs;
  const total = Math.max(lastCount, r);
  const title = r === 1 ? 'FIRST' : ord(r);
  const tk = ++mineToken;
  const t0 = performance.now(), dur = 600;
  readout('st-placed', title, 'CONFIRMING PLACE');
  (function frame(t) {
    if (tk !== mineToken) return;
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    const mg = r === 1 ? '+0' : '+' + Math.round(dest * e);
    readout('st-placed', title,
      r === 1 ? `1ST OF ${total} — PRESS CONFIRMED` : `${ord(r)} OF ${total} · ${mg} MS`);
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
