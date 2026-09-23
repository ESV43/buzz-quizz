/* Host console — broadcast layout render layer. Protocol unchanged. */
const socket = io({ transports: ['websocket', 'polling'], reconnectionDelay: 400, reconnectionDelayMax: 3500 });
const $ = (id) => document.getElementById(id);
let roomCode = null, soundOn = true, voiceOn = true, lastWinnerId = null;
let actx = null;

if (new URLSearchParams(location.search).get('present') === '1') document.body.classList.add('present');

async function keepAwake() { try { await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
keepAwake();

function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2600); }
function ac() {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  } catch { return null; }
}
function buzzSound() {
  if (!soundOn) return;
  const ctx = ac(); if (!ctx) return;
  try {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = 196;
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.65);
  } catch {}
}
function speak(text) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; speechSynthesis.speak(u); } catch {}
}

/* canvas celebration FX */
const fx = $('fx'), fctx = fx.getContext('2d');
let parts = [], fxRun = false;
function sizeFx() { fx.width = innerWidth; fx.height = innerHeight; }
addEventListener('resize', sizeFx); sizeFx();
function confettiBurst() {
  const cols = ['#d9a441', '#edeff2', '#626b77', '#34d17b'];
  for (let i = 0; i < 130; i++) parts.push({
    x: innerWidth / 2 + (Math.random() - .5) * 260, y: innerHeight * 0.28,
    vx: (Math.random() - .5) * 9, vy: -Math.random() * 9 - 3, g: .26,
    w: 3 + Math.random() * 3, h: 7 + Math.random() * 8,
    r: Math.random() * Math.PI, vr: (Math.random() - .5) * .3,
    c: cols[i % 4], life: 80 + Math.random() * 45,
  });
  if (!fxRun) { fxRun = true; requestAnimationFrame(fxTick); }
}
function fxTick() {
  fctx.clearRect(0, 0, fx.width, fx.height);
  parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 30);
  for (const p of parts) {
    p.vy += p.g; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life--;
    fctx.save(); fctx.translate(p.x, p.y); fctx.rotate(p.r);
    fctx.globalAlpha = Math.min(1, p.life / 40); fctx.fillStyle = p.c;
    fctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); fctx.restore();
  }
  if (parts.length) requestAnimationFrame(fxTick);
  else { fxRun = false; fctx.clearRect(0, 0, fx.width, fx.height); }
}

async function probe() {
  if (!socket.connected) return;
  const t0 = performance.now();
  socket.emit('time-sync', { t0: Date.now() }, () => {
    $('connPill').innerHTML = `<span class="livedot"></span>${Math.round(performance.now() - t0)} ms`;
  });
}
socket.on('connect', probe);
let wasOffline = false;
socket.on('disconnect', () => { wasOffline = true; $('connPill').innerHTML = '<span class="livedot idle"></span>Offline'; toast('Link lost — reconnecting'); });
socket.on('connect', () => {
  if (wasOffline) { wasOffline = false; toast('Link restored'); }
  // socket.id changed on reconnect — old hostId is dead, so silently reclaim
  // authority (otherwise arm/kick fail with "Not authorized").
  if (roomCode && $('studio').style.display !== 'none') {
    socket.emit('host-rejoin', { code: roomCode }, (res) => {
      if (!res?.ok) return toast(res?.error || 'Host session lost — reclaim the room');
      enterStudio(res.code || roomCode, res);
    });
  }
});
// reclaim authority once, then retry the blocked action
function reclaimOnce(retry) {
  if (!roomCode || !socket.connected) return toast('Link lost — reconnecting');
  socket.emit('host-rejoin', { code: roomCode }, (res) => {
    if (!res?.ok) return toast(res?.error || 'Host session lost — reclaim the room');
    enterStudio(res.code || roomCode, res);
    retry();
  });
}
setInterval(probe, 10000);

$('createBtn').onclick = () => {
  socket.emit('create-room', { maxTeams: parseInt($('maxTeams').value, 10) }, (res) => {
    if (!res?.ok) return toast('Could not create room');
    enterStudio(res.code, res);
  });
};
$('rejoinBtn').onclick = () => {
  const code = $('rejoinCode').value.trim().toUpperCase();
  if (!code) return toast('Enter the room code');
  socket.emit('host-rejoin', { code }, (res) => {
    if (!res?.ok) {
      const msg = res?.error || 'Room not found';
      // Server restarts wipe in-memory rooms (same on Vercel/Render redeploys).
      // Offer to recreate the SAME code so printed QRs/codes keep working —
      // teams simply rejoin.
      if (/not found/i.test(msg)) {
        toast(msg);
        if (confirm(`Room ${code} not found on the server (it likely restarted).\n\nRecreate room ${code} now? Teams will need to rejoin.`)) {
          socket.emit('create-room', { maxTeams: parseInt($('maxTeams').value, 10) || 16, wantedCode: code }, (r2) => {
            if (!r2?.ok) return toast('Could not recreate room');
            enterStudio(r2.code, r2); toast(`Room ${r2.code} recreated — teams rejoin`);
          });
        }
      } else toast(msg);
      return;
    }
    enterStudio(res.code || code, res); toast('Host session reclaimed');
  });
};
function paintJoinSecrets(code, res) {
  if (res?.qr) $('qr').src = res.qr;
  if (res?.joinUrls?.length) {
    try {
      const u = new URL(res.joinUrls[0]);
      $('joinLink').textContent = u.host + u.pathname + '?room=' + code;
    } catch { $('joinLink').textContent = res.joinUrls[0]; }
    $('joinUrls').innerHTML = res.joinUrls.slice(1, 4).map((u) => `<div>${escapeHtml(u)}</div>`).join('');
    const first = res.joinUrls[0] || '';
    const internet = /^https:\/\//.test(first) && !/localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./.test(first);
    $('netHint').textContent = internet
      ? 'Internet link — works over mobile data, not just same Wi-Fi.'
      : 'Same-Wi-Fi link (local IP). Deploy with PUBLIC_URL for internet play.';
  }
  if (res?.companionUrl) {
    $('companionHint').textContent = res.companionUrl.replace(/^https?:\/\//, '');
    $('companionLink').textContent = res.companionUrl.replace(/^https?:\/\//, '');
  }
  if (res?.companionQr) { $('compQr').src = res.companionQr; $('compQr').style.display = 'block'; }
  else { $('compQr').removeAttribute('src'); $('compQr').style.display = 'none'; }
}
function enterStudio(code, res) {
  roomCode = code;
  $('setup').style.display = 'none'; $('studio').style.display = 'grid';
  $('roomCode').textContent = code;
  $('roomCodeStrip').textContent = code.split('').join(' ');
  $('footRoom').textContent = 'room ' + code;
  if (res?.companionPin) $('compPin').textContent = res.companionPin;
  paintJoinSecrets(code, res);
  try { localStorage.setItem('buzz-host-code', code); } catch {}
  if (res?.state) renderAll(res);
}
try { const saved = localStorage.getItem('buzz-host-code'); if (saved) $('rejoinCode').value = saved; } catch {}

$('revealPin').onclick = () => $('compPin').classList.toggle('open');
$('fullBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => toast('Fullscreen blocked by browser'));
};
function setPresent(on) {
  document.body.classList.toggle('present', !!on);
  const b = $('presentBtn');
  if (b) b.textContent = on ? 'Console' : 'Present';
  toast(on ? 'Present mode — rails hidden (Esc to exit)' : 'Console mode');
}
// projector state is shared: local flips broadcast so the companion label stays in sync
function requestPresent(on) {
  setPresent(on);
  if (roomCode && socket.connected) socket.emit('host-control', { action: 'present', on: !!on }, () => {});
}
$('presentBtn').onclick = () => requestPresent(!document.body.classList.contains('present'));
$('exitPresent').onclick = () => requestPresent(false);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('present')) requestPresent(false);
});
// Host can intentionally hide QR codes + links (projector privacy).
// Both panels mask independently; state persists per session only.
function bindHideToggle(btnId, secretsId, noteId, label) {
  const btn = $(btnId);
  if (!btn) return;
  btn.onclick = () => {
    const sec = $(secretsId), note = $(noteId);
    const hidden = sec.style.display !== 'none';
    sec.style.display = hidden ? 'none' : '';
    if (note) note.style.display = hidden ? 'block' : 'none';
    btn.textContent = hidden ? 'Show' : 'Hide';
    if (hidden) toast(`${label} hidden from projector`);
  };
}
bindHideToggle('toggleJoinVis', 'joinSecrets', 'joinMaskedNote', 'Team codes');
bindHideToggle('toggleCompVis', 'compSecrets', 'compMaskedNote', 'Remote access');
if (document.body.classList.contains('present')) {
  const b = $('presentBtn');
  if (b) b.textContent = 'Console';
}

function flashSpot() {
  const s = $('spot');
  s.classList.remove('flash'); void s.offsetWidth; s.classList.add('flash');
}
function control(action, extra = {}, retried = false) {
  if (!roomCode) return;
  if (action === 'arm' || action === 'next') { paintState(true, null); flashSpot(); }
  else if (action === 'lock' || action === 'reset') paintState(false, null);
  socket.emit('host-control', { action, ...extra }, (r) => {
    if (r && !r.ok && !retried && /authorized|room/i.test(r.error || '')) {
      return reclaimOnce(() => control(action, extra, true));
    }
    if (r && !r.ok) toast(r.error || 'Blocked');
  });
}
$('armBtn').onclick = () => control('arm');
$('lockBtn').onclick = () => control('lock');
$('nextBtn').onclick = () => control('next');
let resetArmed = false, resetT = null;
$('resetBtn').onclick = (e) => {
  const b = e.currentTarget;
  if (!resetArmed) {
    resetArmed = true;
    b.classList.add('confirm'); b.textContent = 'Confirm';
    resetT = setTimeout(() => { resetArmed = false; b.classList.remove('confirm'); b.textContent = 'Reset'; }, 3000);
  } else {
    clearTimeout(resetT);
    resetArmed = false; b.classList.remove('confirm'); b.textContent = 'Reset';
    control('reset');
  }
};
$('soundBtn').onclick = (e) => { soundOn = !soundOn; e.currentTarget.textContent = `Sound ${soundOn ? 'on' : 'off'}`; };
$('voiceBtn').onclick = (e) => { voiceOn = !voiceOn; e.currentTarget.textContent = `Voice ${voiceOn ? 'on' : 'off'}`; };
document.addEventListener('keydown', (e) => {
  if ($('studio').style.display === 'none') return;
  if (e.code === 'Space') { e.preventDefault(); control($('stateWord').classList.contains('live') ? 'lock' : 'arm'); }
  else if (e.key === 'a' || e.key === 'A') control('arm');
  else if (e.key === 'l' || e.key === 'L') control('lock');
  else if (e.key === 'n' || e.key === 'N') control('next');
  else if (e.key === 'r' || e.key === 'R') control('reset');
});

/* coalesced rendering: N socket events per frame => one paint */
let pendingRoom = null, pendingBuzz = null, rafQueued = false;
socket.on('room-update', (d) => { pendingRoom = d; queueRender(); });
socket.on('buzz-update', (d) => { pendingBuzz = d; queueRender(); });
function queueRender() {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    const r = pendingRoom, b = pendingBuzz;
    pendingRoom = pendingBuzz = null;
    if (r) renderAll(r);
    else if (b) renderRanks(b.buzzes, b.armed, b.questionNo);
  });
}
socket.on('control-event', (d) => {
  if (d?.questionNo) setQ(d.questionNo);
  if (d?.action === 'arm' || d?.action === 'next') flashSpot();
  // projector flip from the companion remote (own echo is a no-op — no double toast)
  if (d?.action === 'present' && typeof d?.on === 'boolean') {
    if (document.body.classList.contains('present') !== d.on) setPresent(d.on);
  }
});
socket.on('security-alert', (d) => { $('secLog').innerHTML += `<div>Security — ${escapeHtml(d.msg)} <span class="mono">${new Date().toLocaleTimeString()}</span></div>`; });
socket.on('focus-alert', (d) => {
  if (!d?.away) return; // silent when the team is back — roster badge clears itself
  const msg = `${d.teamName} left the buzzer tab/app`;
  $('secLog').innerHTML += `<div>Focus — ${escapeHtml(msg)} <span class="mono">${new Date().toLocaleTimeString()}</span></div>`;
  toast(msg);
  buzzSound();
  speak(`${d.teamName} left the buzzer`);
});

$('roster').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kick]');
  if (!b) return;
  e.stopPropagation();
  const teamId = b.dataset.kick;
  const kick = (retried = false) => socket.emit('kick-team', { teamId }, (r) => {
    if (r && !r.ok && !retried && /expired|authorized|room/i.test(r.error || '')) {
      return reclaimOnce(() => kick(true));
    }
    if (!r?.ok) toast(r?.error || 'Cannot remove team');
  });
  kick();
});

function setQ(n) {
  const t = String(n ?? '–');
  if ($('qNum')._last !== t) { $('qNum')._last = t; $('qNum').textContent = t; }
  if ($('qNumStrip')._last !== t) { $('qNumStrip')._last = t; $('qNumStrip').textContent = 'Q' + t; }
}
function paintState(armedNow, q) {
  const w = $('stateWord');
  w.classList.toggle('live', !!armedNow);
  w.classList.toggle('locked', !armedNow);
  w.textContent = armedNow ? 'LIVE' : 'LOCKED';
  $('stateSub').textContent = armedNow
    ? (q ? `Question ${q} — accepting presses` : 'Accepting presses')
    : (q ? `Question ${q} closed` : 'Awaiting arm');
  if (q != null) setQ(q);
}

function renderAll({ teams, state }) {
  const tc = `${teams.length} TEAMS`;
  if ($('teamCount')._last !== tc) { $('teamCount')._last = tc; $('teamCount').textContent = tc; }
  paintState(state.armed, state.questionNo);
  paintProgress(teams.length, state.buzzes);
  renderRoster(teams, state.buzzes);
  renderRanks(state.buzzes, state.armed, state.questionNo);
}
function paintProgress(total, buzzes) {
  const n = new Set((buzzes || []).map((b) => b.teamId)).size;
  $('buzzCount').textContent = total ? `${n}/${total} IN` : '';
  $('buzzMeter').style.width = total ? Math.round((n / total) * 100) + '%' : '0';
}

/* keyed roster with FLIP reorder */
const rosEls = new Map(), rosHtml = new Map();
function renderRoster(teams, buzzes = []) {
  const box = $('roster');
  const byId = Object.fromEntries(buzzes.map((x) => [x.teamId, x]));
  const sorted = [...teams].sort((a, b) => (byId[a.id]?.rank ?? 99) - (byId[b.id]?.rank ?? 99));
  const first = new Map();
  for (const [id, el] of rosEls) if (el.isConnected) first.set(id, el.getBoundingClientRect().top);
  const alive = new Set();
  for (const t of sorted) {
    alive.add(t.id);
    const bz = byId[t.id];
    let el = rosEls.get(t.id);
    if (!el) { el = document.createElement('div'); rosEls.set(t.id, el); box.appendChild(el); }
    const status = !t.connected ? 'OUT' : (t.away ? 'AWAY' : 'IN');
    const html = `<span class="bar"></span><span class="nm">${escapeHtml(t.name)}</span>`
      + `${bz && bz.rank <= 3 ? `<span class="pos">P${bz.rank}</span>` : ''}`
      + `${bz && bz.rank > 3 ? `<span class="mg">+${bz.deltaMs}</span>` : ''}`
      + `${t.away && t.connected ? '<span class="away">TAB</span>' : ''}`
      + `<span class="st ${t.connected && !t.away ? 'in' : (t.away ? 'away' : '')}">${status} · ${t.rtt ?? '–'}</span>`
      + `<button class="rm" data-kick="${t.id}" title="Remove team">×</button>`;
    if (rosHtml.get(t.id) !== html) {
      rosHtml.set(t.id, html);
      el.className = 'rrow';
      el.style.setProperty('--c', t.color);
      el.innerHTML = html;
    }
  }
  for (const [id, el] of [...rosEls]) if (!alive.has(id)) { el.remove(); rosEls.delete(id); rosHtml.delete(id); }
  for (const t of sorted) box.appendChild(rosEls.get(t.id));
  for (const [id, el] of rosEls) {
    const f = first.get(id);
    if (f == null) continue;
    const d = f - el.getBoundingClientRect().top;
    if (d) {
      el.style.transition = 'none';
      el.style.transform = `translateY(${d}px)`;
      requestAnimationFrame(() => { el.style.transition = ''; el.style.transform = ''; });
    }
  }
}

/* spotlight + keyed standings */
const rankRows = new Map(), rankHtml = new Map();
let lastSpotKey = null, lastEmpty = null;
const seenBuzz = new Set();
function renderRanks(buzzes = [], armed, q) {
  if (q != null) setQ(q);
  const empty = !buzzes.length;
  if (lastEmpty !== empty) { lastEmpty = empty; $('emptyHint').style.display = empty ? 'block' : 'none'; }
  const w = buzzes[0] || null;
  const skey = w ? w.teamId + ':' + (q ?? '') : 'empty:' + (q ?? '') + ':' + (armed ? 'a' : 'l');
  if (skey !== lastSpotKey) {
    lastSpotKey = skey;
    $('spot').classList.toggle('has-winner', !!w);
    if (!w) {
      $('spotKicker').textContent = armed ? `Question ${q} — open` : 'Standby';
      $('spotName').textContent = 'Awaiting first buzz';
      $('spotMargin').textContent = armed ? 'BUZZERS LIVE — FIRST VALID PRESS TAKES P1' : 'ARM THE BUZZER TO OPEN THE QUESTION';
    } else {
      $('spotKicker').textContent = `Question ${q} — first buzz`;
      $('spotName').textContent = w.teamName;
      $('spotMargin').innerHTML = `MARGIN <b>+0 MS</b> · CORRECTED · LINK ${w.rtt ?? '–'} MS`;
    }
  }
  const tb = $('rankBody');
  if (empty) {
    if (tb._emptied !== true) { tb._emptied = true; tb.innerHTML = ''; }
    for (const [, tr] of rankRows) tr.remove();
    rankRows.clear(); rankHtml.clear(); seenBuzz.clear();
  } else {
    tb._emptied = false;
    const first = new Map();
    for (const [id, tr] of rankRows) if (tr.isConnected) first.set(id, tr.getBoundingClientRect().top);
    const alive = new Set();
    for (const b of buzzes) {
      alive.add(b.teamId);
      let tr = rankRows.get(b.teamId);
      if (!tr) { tr = document.createElement('tr'); rankRows.set(b.teamId, tr); tb.appendChild(tr); }
      const t = new Date(b.adjustedTime);
      const html = `<td class="pos">P${b.rank}</td>`
        + `<td><span class="tchip" style="background:${b.color}"></span><span class="tname">${escapeHtml(b.teamName)}</span></td>`
        + `<td class="num">${t.toLocaleTimeString()}.${String(t.getMilliseconds()).padStart(3, '0')}</td>`
        + `<td class="tmargin ${b.deltaMs === 0 ? 'first' : ''}">${b.deltaMs === 0 ? '+0 — P1' : '+' + b.deltaMs}</td>`
        + `<td class="num" style="color:var(--faint)">${b.rtt ?? '–'} ms</td>`;
      if (rankHtml.get(b.teamId) !== html) {
        rankHtml.set(b.teamId, html);
        tr.className = b.rank === 1 ? 'pos1' : '';
        tr.innerHTML = html;
      }
      if (!seenBuzz.has(b.teamId)) { seenBuzz.add(b.teamId); tr.classList.add('fresh'); }
    }
    for (const [id, tr] of [...rankRows]) if (!alive.has(id)) { tr.remove(); rankRows.delete(id); rankHtml.delete(id); }
    for (const b of buzzes) tb.appendChild(rankRows.get(b.teamId));
    for (const [id, tr] of rankRows) {
      const f = first.get(id);
      if (f == null) continue;
      const d = f - tr.getBoundingClientRect().top;
      if (d) {
        tr.style.transition = 'none';
        tr.style.transform = `translateY(${d}px)`;
        requestAnimationFrame(() => { tr.style.transition = ''; tr.style.transform = ''; });
      }
    }
  }
  if (w && w.teamId !== lastWinnerId) {
    lastWinnerId = w.teamId;
    buzzSound(); speak(`${w.teamName} buzzed first`); confettiBurst();
    const sp = $('spot');
    sp.classList.remove('pop'); void sp.offsetWidth; sp.classList.add('pop');
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
