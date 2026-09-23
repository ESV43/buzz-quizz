/* Quizmaster remote */
const socket = io({ transports: ['websocket', 'polling'], reconnectionDelay: 400, reconnectionDelayMax: 3500 });
const $ = (id) => document.getElementById(id);
async function keepAwake() { try { await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
function toast(m) { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2400); }
try {
  const q = new URLSearchParams(location.search).get('room');
  $('code').value = (q || localStorage.getItem('buzz-room') || '').toUpperCase();
  if (q) try { localStorage.setItem('buzz-room', q.toUpperCase()); } catch {}
} catch {}
let unlocked = false, awayTeams = new Map();
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
  socket.emit('join-as-companion', { code, pin }, (res) => {
    if (!res?.ok) { $('err').textContent = res?.error || 'Denied'; return; }
    try { sessionStorage.setItem('buzz-companion', JSON.stringify({ code, pin })); } catch {}
    showRemote(res.state, res.teams); toast('Remote unlocked');
  });
};
function ctl(a) { socket.emit('host-control', { action: a }, (r) => { if (r && !r.ok) toast(r.error || 'Blocked'); else try { navigator.vibrate?.(30); } catch {} }); }
$('arm').onclick = () => ctl('arm'); $('lock').onclick = () => ctl('lock');
$('next').onclick = () => ctl('next');
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
socket.on('buzz-update', (d) => paint({ armed: d.armed, questionNo: d.questionNo, buzzes: d.buzzes }));
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
  $('st').textContent = `Q${state.questionNo || '–'} · ${state.armed ? 'Live' : 'Locked'} · ${state.buzzes?.length || 0} presses`;
  const w = state.buzzes?.[0];
  $('winner').textContent = w ? `${w.teamName} · +${w.deltaMs} ms` : 'Awaiting press';
  $('mini').textContent = (state.buzzes || []).slice(0, 5).map((b) => `P${b.rank} ${b.teamName} +${b.deltaMs}`).join('   ');
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
