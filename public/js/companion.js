/* Quizmaster remote — hardened link + 3-2-1 countdown */
const socket = io({
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
async function keepAwake() { try { await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { keepAwake(); if (!socket.connected) try { socket.connect(); } catch {} }
});
window.addEventListener('online', () => { try { socket.connect(); } catch {} });
function toast(m) { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2400); }
try {
  const q = new URLSearchParams(location.search).get('room');
  $('code').value = (q || localStorage.getItem('buzz-room') || '').toUpperCase();
  if (q) try { localStorage.setItem('buzz-room', q.toUpperCase()); } catch {}
} catch {}
let unlocked = false, awayTeams = new Map();
let compCountdown = null, compCountdownTimer = null;
function creds() { try { return JSON.parse(sessionStorage.getItem('buzz-companion') || 'null'); } catch { return null; } }
function showRemote(state, teams) {
  unlocked = true;
  $('lockCard').style.display = 'none'; $('remote').style.display = 'block'; keepAwake();
  paint(state, teams);
}
function showLocked(err) {
  unlocked = false;
  $('remote').style.display = 'none'; $('lockCard').style.display = 'block';
  if (err) $('err').textContent = err;
}
function renderAway() {
  const box = $('awayPanel'), list = $('awayList');
  if (!box || !list) return;
  const arr = [...awayTeams.values()];
  box.style.display = arr.length ? 'block' : 'none';
  list.innerHTML = arr.map((t) =>
    `<div class="orow"><span class="tchip" style="background:${t.color || '#888'}"></span>`
    + `<span>${escapeHtml(t.name)}</span><span class="awaytag">LEFT APP</span></div>`).join('');
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
$('unlock').onclick = () => {
  const code = $('code').value.trim().toUpperCase(), pin = $('pin').value.trim();
  if (!code || !pin) return $('err').textContent = 'Enter both the room code and the PIN.';
  if (!socket.connected) try { socket.connect(); } catch {}
  $('unlock').disabled = true;
  socket.timeout(8000).emit('join-as-companion', { code, pin }, (err, res) => {
    $('unlock').disabled = false;
    if (err) { $('err').textContent = 'Slow link — retry unlock.'; return; }
    if (!res?.ok) { $('err').textContent = res?.error || 'Denied'; return; }
    try { sessionStorage.setItem('buzz-companion', JSON.stringify({ code, pin })); } catch {}
    showRemote(res.state, res.teams); toast('Remote unlocked');
  });
};
function ctl(a) {
  if (!socket.connected) { toast('Link lost — reconnecting'); try { socket.connect(); } catch {} return; }
  if (a === 'arm' || a === 'next') {
    // Optimistic 3-2-1 — server ticks correct it. Arm runs countdown too.
    const qGuess = (parseInt(($('st').textContent.match(/Q(\d+)/)?.[1] || '0'), 10) || 0) + 1;
    showCompCountdown(3, qGuess);
  }
  try {
    socket.timeout(8000).emit('host-control', { action: a }, (err, r) => {
      if (err) return toast('Slow link — watch the host screen to confirm');
      if (r && !r.ok) toast(r.error || 'Blocked');
      else {
        try { navigator.vibrate?.(30); } catch {}
        if ((a === 'next' || a === 'arm') && r?.state?.countdown?.active) showCompCountdown(3, r.state.questionNo);
      }
    });
  } catch { toast('Send failed — retry'); }
}
$('arm').onclick = () => ctl('arm'); $('lock').onclick = () => ctl('lock');
$('next').onclick = () => ctl('next');
function showCompCountdown(count, q) {
  const key = `${count}:${q}`;
  if (showCompCountdown._key === key && compCountdown) return;
  showCompCountdown._key = key;
  compCountdown = { count, questionNo: q };
  $('st').textContent = `Q${q || '–'} · READY ${count}`;
  $('winner').textContent = `${count}… buzzers opening`;
  try { navigator.vibrate?.(40); } catch {}
  for (const id of ['arm', 'next']) { const b = $(id); if (b) b.disabled = true; }
  if (compCountdownTimer) clearTimeout(compCountdownTimer);
  compCountdownTimer = setTimeout(clearCompCountdownGate, 6000);
}
function clearCompCountdownGate() {
  compCountdown = null;
  showCompCountdown._key = null;
  if (compCountdownTimer) { clearTimeout(compCountdownTimer); compCountdownTimer = null; }
  for (const id of ['arm', 'next']) { const b = $(id); if (b) b.disabled = false; }
}
// projector flip on the host screen — applied on ack, synced from host flips too
let projectorPresent = false;
function paintPresent() {
  const b = $('present');
  if (b) b.textContent = projectorPresent ? 'Projector: present' : 'Projector: console';
}
$('present').onclick = () => {
  const next = !projectorPresent;
  socket.emit('host-control', { action: 'present', on: next }, (r) => {
    if (r && !r.ok) { toast(r.error || 'Blocked'); return; }
    projectorPresent = next; paintPresent();
    try { navigator.vibrate?.(30); } catch {}
  });
};
socket.on('control-event', (d) => {
  if (d?.action === 'present' && typeof d?.on === 'boolean') {
    projectorPresent = d.on; paintPresent();
  }
  if (d?.action === 'countdown') showCompCountdown(d.count || 3, d.questionNo);
  if (d?.action === 'arm') { clearCompCountdownGate(); toast(d?.via === 'countdown' ? 'Buzzers live' : 'Armed'); }
  if (d?.action === 'lock' || d?.action === 'reset') clearCompCountdownGate();
});
let cresetArmed = false, cresetT = null;
$('reset').onclick = (e) => {
  const b = e.currentTarget;
  if (!cresetArmed) {
    cresetArmed = true;
    b.classList.add('confirm'); b.textContent = 'Confirm';
    cresetT = setTimeout(() => { cresetArmed = false; b.classList.remove('confirm'); b.textContent = 'Reset'; }, 3000);
  } else {
    clearTimeout(cresetT);
    cresetArmed = false; b.classList.remove('confirm'); b.textContent = 'Reset';
    ctl('reset');
  }
};
$('bye').onclick = () => { try { sessionStorage.removeItem('buzz-companion'); } catch {} location.reload(); };
socket.on('disconnect', () => toast('Connection lost — reconnecting'));
socket.on('connect', () => {
  // socket.id changed — old companion grant is dead, reclaim it silently
  const c = creds();
  if (c && (unlocked || $('remote').style.display !== 'none')) {
    socket.emit('join-as-companion', c, (res) => {
      if (!res?.ok) return showLocked(res?.error || 'Remote session lost — unlock again.');
      showRemote(res.state, res.teams);
    });
  } else if ($('remote').style.display !== 'none') toast('Reconnected');
});
socket.on('room-update', ({ teams, state }) => paint(state, teams));
socket.on('buzz-update', (d) => paint({ armed: d.armed, questionNo: d.questionNo, buzzes: d.buzzes, countdown: d.countdown }));
socket.on('focus-alert', (d) => {
  if (!d) return;
  if (d.away) {
    const prev = awayTeams.get(d.teamId);
    awayTeams.set(d.teamId, { id: d.teamId, name: d.teamName, color: prev?.color || '#888' });
    renderAway();
    toast(`${d.teamName} left the app`);
    try { navigator.vibrate?.(60); } catch {}
  } else {
    if (awayTeams.delete(d.teamId)) renderAway(); // silent return
  }
});
function paint(state, teams) {
  if (!state) return;
  if (state.countdown?.active) {
    // Same +60ms grace as player/host so the remote digit flips in step.
    const remain = Math.max(0, (state.countdown.endsAt || Date.now()) - Date.now());
    showCompCountdown(Math.min(3, Math.max(1, Math.ceil((remain + 60) / 1000))), state.questionNo);
    return;
  }
  if (compCountdown) clearCompCountdownGate();
  $('st').textContent = `Q${state.questionNo || '–'} · ${state.armed ? 'Live' : 'Locked'} · ${state.buzzes?.length || 0} presses`;
  const w = state.buzzes?.[0];
  $('winner').textContent = w ? `${w.teamName} · +${w.deltaMs} ms` : 'Awaiting press';
  const ranks = (state.buzzes || []).slice(0, 5);
  $('mini').innerHTML = ranks.length
    ? ranks.map((b) =>
      `<div class="orow"><span class="mono">P${b.rank}</span><span>${escapeHtml(b.teamName)}</span>`
      + `<span class="mono">+${b.deltaMs}</span></div>`).join('')
    : '<p class="note" style="text-align:center">No presses.</p>';
  if (Array.isArray(teams)) {
    awayTeams = new Map(teams.filter((t) => t.away).map((t) => [t.id, t]));
    renderAway();
  }
}
// returning quizmaster (same tab): skip PIN re-entry when session kept
try {
  const c = creds();
  if (c && c.code) {
    $('code').value = c.code;
    socket.on('connect', () => {
      if (!unlocked) socket.emit('join-as-companion', c, (res) => {
        if (res?.ok) { showRemote(res.state, res.teams); toast('Remote restored'); }
      });
    });
  }
} catch {}
