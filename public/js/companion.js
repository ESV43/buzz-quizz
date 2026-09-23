/* Quizmaster remote */
const socket = io({ transports: ['websocket', 'polling'], reconnectionDelay: 400, reconnectionDelayMax: 3500 });
const $ = (id) => document.getElementById(id);
async function keepAwake() { try { await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
function toast(m) { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2400); }
try { $('code').value = (localStorage.getItem('buzz-room') || '').toUpperCase(); } catch {}
$('unlock').onclick = () => {
  const code = $('code').value.trim().toUpperCase(), pin = $('pin').value.trim();
  if (!code || !pin) return $('err').textContent = 'Enter both the room code and the PIN.';
  socket.emit('join-as-companion', { code, pin }, (res) => {
    if (!res?.ok) { $('err').textContent = res?.error || 'Denied'; return; }
    $('lockCard').style.display = 'none'; $('remote').style.display = 'block'; keepAwake();
    paint(res.state); toast('Remote unlocked');
  });
};
function ctl(a) { socket.emit('host-control', { action: a }, (r) => { if (r && !r.ok) toast(r.error || 'Blocked'); else try { navigator.vibrate?.(30); } catch {} }); }
$('arm').onclick = () => ctl('arm'); $('lock').onclick = () => ctl('lock');
$('next').onclick = () => ctl('next'); $('reset').onclick = () => ctl('reset');
$('bye').onclick = () => location.reload();
socket.on('room-update', ({ state }) => paint(state));
socket.on('buzz-update', (d) => paint({ armed: d.armed, questionNo: d.questionNo, buzzes: d.buzzes }));
function paint(state) {
  if (!state) return;
  $('st').textContent = `Q${state.questionNo || '–'} · ${state.armed ? 'Live' : 'Locked'} · ${state.buzzes?.length || 0} presses`;
  const w = state.buzzes?.[0];
  $('winner').textContent = w ? `${w.teamName} · +${w.deltaMs} ms` : 'Awaiting press';
  $('mini').textContent = (state.buzzes || []).slice(0, 5).map((b) => `P${b.rank} ${b.teamName} +${b.deltaMs}`).join('   ');
}
