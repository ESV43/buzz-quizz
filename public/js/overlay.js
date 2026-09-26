/* Buzz overlay — OBS Browser Source spectator.
 * Transparent lower-third + 3D standings chart. Joins read-only via
 * join-as-spectator, never buzzes.
 * URL params: room=XXXXX (required for auto-join) · style=lower-third|topbar|center
 *   top=8 (1-8 bars in the 3D chart, always 8 slots) · hideIdle=1 (hide when locked + empty) · startHidden=1
 */
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);

  const style = (qs.get('style') || 'lower-third').toLowerCase();
  if (['lower-third', 'topbar', 'center'].includes(style)) document.body.dataset.style = style;
  const topN = Math.min(Math.max(parseInt(qs.get('top') || '8', 10) || 8, 1), 8);
  const hideIdle = qs.get('hideIdle') === '1' || qs.get('hideWhenLocked') === '1';
  let overlayOn = qs.get('startHidden') !== '1' && qs.get('hidden') !== '1';

  let roomCode = (qs.get('room') || '').toUpperCase().trim();
  let lastState = null;

  const socket = io({
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 15000,
  });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function ord(n) {
    const s = ['TH', 'ST', 'ND', 'RD'], v = n % 100;
    const suf = (s[(v - 20) % 10] || s[v] || s[0]).toLowerCase();
    return n + suf;
  }
  /* Shade a #rrggbb team colour for the 3D faces (top lighter, side darker). */
  function shade(hex, amt) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return hex || '#888';
    let n = parseInt(m[1], 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const t = amt < 0 ? 0 : 255, p = Math.abs(amt) / 100;
    r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }
  /* Podium-stepped heights (rank, not ms): reads at slide-corner scale even
   * when P1..P8 are milliseconds apart. Spread across all 8 slots so P8 is
   * still distinct from the flat ghost stub. */
  function barHeight(rank, slots) {
    const n = Math.max(1, slots || topN);
    const isTop = document.body.dataset.style === 'topbar';
    const base = isTop ? 190 : 272;
    const minH = isTop ? 56 : 72;
    if (n <= 1) return base;
    const step = (base - minH) / (n - 1);
    return Math.max(minH, Math.round(base - (rank - 1) * step));
  }
  function ghostHeight() {
    return document.body.dataset.style === 'topbar' ? 22 : 26;
  }
  function pressClock(b) {
    try {
      const t = new Date(b.adjustedTime);
      return t.toLocaleTimeString() + '.' + String(t.getMilliseconds()).padStart(3, '0');
    } catch { return ''; }
  }
  function showErr(msg) {
    const e = $('err');
    if (!msg) { e.classList.remove('show'); e.textContent = ''; return; }
    e.textContent = msg; e.classList.add('show');
    clearTimeout(showErr._h);
    showErr._h = setTimeout(() => e.classList.remove('show'), 4000);
  }

  function applyVisibility() {
    document.body.classList.toggle('ov-hidden', !overlayOn);
    const s = lastState;
    const idle = !!(s && !s.armed && !(s.buzzes || []).length && !s.countdown?.active);
    document.body.classList.toggle('idle-hidden', !!(hideIdle && idle));
  }

  function tickFromRemain(remainMs) {
    return Math.min(3, Math.max(1, Math.ceil((Math.max(0, remainMs) + 60) / 1000)));
  }

  /* Keyed 3D bars: 8 slots total, a bar rises only when its team buzzes.
   * Filled bars are keyed by teamId (stable nodes => height transitions +
   * pop on change); empty slots render as flat ghost stubs that the next
   * buzz replaces with a rising bar. */
  const barEls = new Map(); // teamId -> .bcol (filled bars only)
  let lastChartKey = '';
  function clearChart() {
    for (const [, el] of barEls) el.remove();
    barEls.clear();
    lastChartKey = '';
    $('chart').classList.remove('show');
    $('bars').innerHTML = '';
    $('chartFoot').innerHTML = '';
  }
  function makeCol() {
    const el = document.createElement('div');
    el.innerHTML = '<div class="blabel"><div class="bt"></div><div class="bm"></div><div class="bk"></div></div>'
      + '<div class="bar3d"><div class="bar-top"></div><div class="bar-side"></div>'
      + '<div class="bar-front"><span class="ord"></span></div></div>';
    return el;
  }
  function paintFilled(el, b, state, slots) {
    const c = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#3a7ca5';
    const isFirst = b.rank === 1;
    el.className = 'bcol' + (isFirst ? ' first' : '');
    el.style.animationDelay = '';
    el.style.setProperty('--c', c);
    el.style.setProperty('--c-light', shade(c, 32));
    el.style.setProperty('--c-dark', shade(c, -38));
    el.style.removeProperty('--ghost');
    const h = barHeight(b.rank || 1, slots);
    const bar = el.querySelector('.bar3d');
    bar.style.setProperty('--h', h + 'px');
    bar.style.height = h + 'px';
    el.querySelector('.bt').textContent = b.teamName || 'Team';
    const delta = b.deltaMs === 0 ? '+0 MS' : '+' + b.deltaMs + ' MS';
    el.querySelector('.bm').textContent = (isFirst ? 'WINNER · ' : '') + delta;
    el.querySelector('.bk').textContent = 'LINK ' + (b.rtt ?? '–') + ' MS';
    el.querySelector('.ord').textContent = ord(b.rank || 1);
    const clk = pressClock(b);
    el.title = `${b.teamName} · P${b.rank} · ${delta} · link ${b.rtt ?? '–'} ms`
      + (clk ? ` · pressed ${clk}` : '') + ` · Q${state.questionNo || '–'}`;
  }
  function paintGhost(el, rank, slots) {
    el.className = 'bcol ghost';
    el.style.animationDelay = '';
    el.style.removeProperty('--c');
    el.style.removeProperty('--c-light');
    el.style.removeProperty('--c-dark');
    const h = ghostHeight();
    const bar = el.querySelector('.bar3d');
    bar.style.setProperty('--h', h + 'px');
    bar.style.height = h + 'px';
    el.querySelector('.bt').textContent = '—';
    el.querySelector('.bm').textContent = 'WAITING';
    el.querySelector('.bk').textContent = '';
    el.querySelector('.ord').textContent = ord(rank);
    el.title = `P${rank} — awaiting press`;
  }
  function renderChart(buzzes, state) {
    const slots = Math.min(Math.max(topN, 1), 8);
    const show = (buzzes || []).slice(0, slots);
    const box = $('bars');
    $('chart').classList.add('show');
    $('chart').dataset.slots = String(slots);
    $('rows').innerHTML = ''; // chart replaces the flat chips when visible
    // Reconcile filled bars (keyed by team, stable across paints).
    const alive = new Set(show.map((b) => b.teamId));
    for (const [id, el] of [...barEls]) {
      if (!alive.has(id)) { el.remove(); barEls.delete(id); }
    }
    for (const b of show) {
      let el = barEls.get(b.teamId);
      const isNew = !el;
      if (isNew) {
        el = makeCol();
        barEls.set(b.teamId, el);
      }
      paintFilled(el, b, state, slots);
      el._isNew = isNew;
    }
    // Order filled by rank, then pad ghosts up to `slots` total.
    for (const b of show) box.appendChild(barEls.get(b.teamId));
    box.querySelectorAll('.bcol.ghost').forEach((g) => g.remove());
    for (let r = show.length + 1; r <= slots; r++) {
      const g = makeCol();
      paintGhost(g, r, slots);
      box.appendChild(g);
    }
    // Animate: brand-new bars rise; rank changes pop.
    const key = show.map((b) => b.teamId + ':' + b.rank).join('|');
    const prev = lastChartKey;
    lastChartKey = key;
    if (!prev) {
      // First paint with data: stagger the rise left-to-right.
      show.forEach((b, i) => {
        const el = barEls.get(b.teamId);
        el.style.animationDelay = (i * 90) + 'ms';
      });
    } else if (key !== prev) {
      for (const b of show) {
        const el = barEls.get(b.teamId);
        if (el._isNew || true) {
          el.classList.remove('pop');
          void el.offsetWidth;
          el.classList.add('pop');
        }
      }
    }
    for (const b of show) { const el = barEls.get(b.teamId); if (el) el._isNew = false; }
    const total = (buzzes || []).length;
    const extra = total - show.length;
    const st = state.armed ? 'LIVE' : 'LOCKED';
    $('chartFoot').innerHTML = `<span>Q${esc(String(state.questionNo || '–'))} · ${st} · ${show.length}/${slots} IN</span>`
      + (extra > 0 ? `<span class="more">+${extra} MORE</span>` : '')
      + (total === 0 ? `<span>BUZZ TO RISE</span>` : '');
    const cnt = $('count');
    if (cnt) cnt.textContent = total ? total + ' IN' : '';
  }
  function paint(state) {
    if (!state) return;
    lastState = state;
    const buzzes = state.buzzes || [];
    const q = state.questionNo || '–';

    // Countdown owns the card.
    if (state.countdown?.active) {
      const remain = Math.max(0, (state.countdown.endsAt || Date.now()) - Date.now());
      const n = tickFromRemain(remain);
      $('ov').style.display = 'block';
      $('q').textContent = 'Q' + q;
      const pill = $('pill');
      pill.textContent = 'READY ' + n;
      pill.className = 'pill ready';
      $('main').innerHTML = `<div class="count-big">${n}</div><div class="count-sub">BUZZERS OPEN WHEN THE COUNT HITS ZERO</div>`;
      $('rows').innerHTML = '';
      clearChart();
      const cnt0 = $('count');
      if (cnt0) cnt0.textContent = '';
      applyVisibility();
      return;
    }

    $('q').textContent = state.questionNo ? 'Q' + state.questionNo : 'STANDBY';
    const pill = $('pill');
    if (state.armed) { pill.textContent = 'LIVE'; pill.className = 'pill live'; }
    else { pill.textContent = 'LOCKED'; pill.className = 'pill locked'; }

    const w = buzzes[0] || null;
    if (!w) {
      if (state.armed) {
        // Live with no presses yet: 8 flat ghost slots waiting — each rises
        // only when its team buzzes.
        $('main').innerHTML = `<div class="winner" style="font-size:clamp(22px,2.4vw,36px)">Buzzers live — awaiting first press</div><div class="sub">FIRST VALID PRESS TAKES P1 · ${topN} SLOTS</div>`;
        renderChart([], state);
      } else {
        $('main').innerHTML = `<div class="winner" style="font-size:clamp(22px,2.4vw,36px)">Standby — arm to open Q${q === '–' ? '' : q}</div><div class="sub">OVERLAY LINKED · WAITING FOR HOST</div>`;
        $('rows').innerHTML = '';
        clearChart();
        const cnt1 = $('count');
        if (cnt1) cnt1.textContent = '';
      }
    } else {
      const clk = pressClock(w);
      $('main').innerHTML = `<div class="winner"><span class="p1">P1</span>${esc(w.teamName)}</div>`
        + `<div class="sub">MARGIN <b>+0 MS</b> · CORRECTED · LINK ${w.rtt ?? '–'} MS · Q${esc(String(q))}`
        + (clk ? ` · ${esc(clk)}` : '') + ` · ${buzzes.length} PRESS${buzzes.length === 1 ? '' : 'ES'}</div>`;
      // 3D chart carries every placing (team · rank · margin · link · press
      // clock in the tooltip); flat chips are hidden while it is shown.
      renderChart(buzzes, state);
    }
    $('ov').style.display = 'block';
    applyVisibility();
  }

  function join() {
    if (!roomCode || !socket.connected) return;
    socket.emit('join-as-spectator', { code: roomCode }, (res) => {
      if (!res?.ok) {
        showErr(res?.error || 'Room not found — check the host code');
        // Keep retrying: host may recreate the room after a restart.
        clearTimeout(join._rt);
        join._rt = setTimeout(join, 5000);
        return;
      }
      showErr(null);
      $('setup').classList.remove('show');
      try { history.replaceState(null, '', `?room=${roomCode}&style=${document.body.dataset.style}&top=${topN}${hideIdle ? '&hideIdle=1' : ''}`); } catch {}
      paint(res.state);
    });
  }

  // Manual pairing when ?room= is missing (test window — not the OBS path).
  if (!roomCode) $('setup').classList.add('show');
  $('join').onclick = () => {
    const c = $('code').value.trim().toUpperCase();
    if (!c) return;
    roomCode = c;
    join();
  };
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });

  socket.on('connect', join);
  socket.on('room-update', (d) => { if (d?.state) paint({ ...d.state, buzzes: d.state.buzzes }); });
  socket.on('buzz-update', (d) => {
    paint({ armed: d.armed, questionNo: d.questionNo, buzzes: d.buzzes, countdown: d.countdown || null });
  });
  socket.on('control-event', (d) => {
    if (!d) return;
    if (d.action === 'countdown') {
      paint({ armed: false, questionNo: d.questionNo, buzzes: [], countdown: { active: true, endsAt: d.endsAt || Date.now() + 1500 } });
      // Replace with the exact tick the server sent.
      const pill = $('pill');
      pill.textContent = 'READY ' + (d.count || 3);
      pill.className = 'pill ready';
      $('main').innerHTML = `<div class="count-big">${esc(String(d.count || 3))}</div><div class="count-sub">BUZZERS OPEN WHEN THE COUNT HITS ZERO</div>`;
      $('ov').style.display = 'block';
      lastState = lastState || {};
      lastState.countdown = { active: true, endsAt: d.endsAt || Date.now() + 1500 };
      applyVisibility();
      return;
    }
    if (d.action === 'overlay' && typeof d.on === 'boolean') {
      overlayOn = d.on;
      applyVisibility();
      return;
    }
    // arm/lock/reset/next arrive as state via room-update + buzz-update; nothing extra needed.
  });
  socket.on('disconnect', () => showErr('Link lost — reconnecting…'));
  /* Host closed the room: clear the card and wait for a new code. */
  socket.on('room-closed', (d) => {
    if (d?.code && roomCode && d.code !== roomCode) return;
    roomCode = '';
    lastState = null;
    clearTimeout(join._rt);
    clearChart();
    $('rows').innerHTML = '';
    $('ov').style.display = 'none';
    $('setup').classList.add('show');
    showErr('Room closed by host — enter a new code');
    try { history.replaceState(null, '', location.pathname); } catch {}
  });

  applyVisibility();
})();
