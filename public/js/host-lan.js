/* QSI Buzz — LAN·P2P host controller (runs inside host.html, studioLan).
 * No install, no addresses: this tab is the referee over Wi-Fi (WebRTC via
 * PeerJS cloud for introductions only — buzzes stay on the local network).
 * Room codes stay 5 chars; peer IDs are `qsi-buzz-<CODE>`.
 * State authority: js/p2p-host-store.js (same rules as the Node server).
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function toast(m) {
    var t = $('toast'); if (!t) return;
    t.textContent = m; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none'; }, 2600);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]);
    });
  }

  var peer = null, store = null, lanCode = null, tries = 0;
  var peers = new Map(); // peerId -> { wrapped, role, teamId, conn }
  var lastWinnerId = null;

  var COMPANION_ALLOW = { arm: 1, lock: 1, reset: 1, next: 1, clear: 1 };

  function broadcastAll(type, payload) {
    for (var e of peers.values()) {
      try { e.wrapped.send(type, payload); } catch (err) {}
    }
    if (!store) return;
    if (type === 'room-update' || type === 'buzz-update') {
      renderLan(store.publicTeams(), store.publicState());
    } else if (type === 'control-event') {
      onLanControl(payload);
    }
  }

  function onLanControl(d) {
    if (d && d.action === 'countdown') renderCountdown(d.count || 3, d.questionNo);
  }

  function dropPeer(pid) {
    peers.delete(pid);
    paintPeers();
    try { if (store) renderLan(store.publicTeams(), store.publicState()); } catch (e) {}
  }

  function routeMessage(conn, wrapped, msg, reply) {
    var entry = peers.get(conn.peer);
    if (!entry || !store) return;
    var t = msg.t;
    if (t === 'time-sync') return reply({ serverTime: Date.now() });
    if (t === 'join-as-player') {
      var res = store.handlePlayerJoin(msg, conn.peer);
      if (res.ok) { entry.role = 'player'; entry.teamId = res.team.id; }
      reply(res); paintPeers(); return;
    }
    if (t === 'buzz') {
      reply(store.handleBuzz({
        teamId: entry.teamId, clientPressTime: msg.clientPressTime,
        offset: msg.offset, rtt: msg.rtt, buzzId: msg.buzzId,
      }));
      return;
    }
    if (t === 'rename-team') {
      // Rename = rejoin with the same teamId and a new name.
      var r = store.handlePlayerJoin({ teamName: msg.name, teamId: entry.teamId });
      reply(r.ok ? { ok: true, name: r.team.name } : r);
      return;
    }
    if (t === 'join-as-companion') {
      var c = store.handleCompanionJoin(msg);
      if (c.ok) entry.role = 'companion';
      reply(c); paintPeers(); return;
    }
    if (t === 'companion-control') {
      if (entry.role !== 'companion') return reply({ ok: false, error: 'Not a companion' });
      if (!COMPANION_ALLOW[msg.action]) return reply({ ok: false, error: 'Not allowed' });
      store.control(msg.action);
      return reply({ ok: true, state: store.publicState() });
    }
    if (t === 'update-netstats' || t === 'focus-status' || t === 'wake-status') {
      return reply({ ok: true });
    }
    return reply({ ok: false, error: 'Unknown message' });
  }

  function joinUrl() {
    return location.origin + '/play-p2p.html?room=' + lanCode;
  }

  function createRoom(maxTeams, attempt) {
    attempt = attempt || 1;
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    peers.clear();
    var okLib;
    var go = function () {
      var code = window.BuzzP2P.makeRoomCode();
      var id = window.BuzzP2P.roomToPeerId(code);
      try { peer = new Peer(id, { debug: 0 }); }
      catch (e) { toast('Browser blocked WebRTC — use Chrome / Safari'); return; }
      peer.on('error', function (err) {
        if (err && (err.type === 'unavailable-id' || err.type === 'peer-unavailable')) {
          try { peer.destroy(); } catch (e2) {}
          peer = null;
          if (attempt < 3) { createRoom(maxTeams, attempt + 1); return; }
          toast('Code clash — tap Create room again');
        } else {
          toast('Peer link: ' + ((err && err.type) || 'notice'));
        }
      });
      peer.on('open', function () {
        lanCode = code;
        store = window.BuzzP2PStore.create({ maxTeams: maxTeams, onBroadcast: broadcastAll });
        enterLanStudio();
      });
      peer.on('connection', function (conn) {
        conn.on('open', function () {
          var wrapped = window.BuzzP2P.wrapConn(conn, function (m, r) { routeMessage(conn, wrapped, m, r); });
          peers.set(conn.peer, { wrapped: wrapped, role: 'unknown', teamId: null, conn: conn });
          paintPeers();
          conn.on('close', function () { dropPeer(conn.peer); });
          conn.on('error', function () { dropPeer(conn.peer); });
        });
      });
      peer.on('disconnected', function () { try { peer.reconnect(); } catch (e) {} });
    };
    if (window.BuzzP2P && window.Peer) { go(); return; }
    if (!window.BuzzP2P) { toast('LAN engine still loading — retry in a second'); return; }
    window.BuzzP2P.ensurePeerJs().then(function (ok) {
      if (!ok) { toast('Could not load WebRTC — check internet once, then retry'); return; }
      go();
    });
  }

  function enterLanStudio() {
    window.__p2pActive = true;
    $('setup').style.display = 'none';
    var sn = $('studioNet'); if (sn) sn.style.display = 'none';
    $('studioLan').style.display = 'grid';
    $('roomCodeL').textContent = lanCode;
    $('roomCodeStrip').textContent = lanCode.split('').join(' ');
    var fh = $('footRoom'); if (fh) fh.textContent = 'room ' + lanCode + ' · LAN';
    var pill = $('connPill');
    if (pill) pill.innerHTML = '<span class="livedot"></span>Hosting in this tab';
    var url = joinUrl();
    $('joinLinkL').textContent = url.replace(/^https?:\/\//, '');
    $('joinLinkL').dataset.full = url;
    $('qrL').src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(url);
    $('compPinL').textContent = store.companionPin;
    var compUrl = location.origin + '/companion-p2p.html?room=' + lanCode;
    $('companionLinkL').textContent = compUrl.replace(/^https?:\/\//, '');
    $('companionLinkL').dataset.full = compUrl;
    $('compQrL').src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(compUrl);
    paintPeers();
    renderLan(store.publicTeams(), store.publicState());
    toast('LAN room ' + lanCode + ' live — share the QR');
  }

  function paintPeers() {
    var el = $('peerNoteL');
    if (!el) return;
    var n = peers.size;
    el.textContent = n
      ? (n + ' device(s) linked — direct over this Wi-Fi when possible.')
      : 'No devices yet — share the QR. Keep this tab frontmost.';
  }

  function control(action) {
    if (!store) return;
    store.control(action);
    renderLan(store.publicTeams(), store.publicState());
  }

  function setQ(n) {
    var t = String(n == null ? '–' : n);
    $('qNumL').textContent = t;
    $('qNumStrip').textContent = 'Q' + t;
  }
  function renderCountdown(count, q) {
    var w = $('stateWordL');
    w.classList.remove('live'); w.classList.add('locked');
    w.textContent = 'READY ' + count;
    $('stateSubL').textContent = 'Question ' + q + ' — buzzers open in ' + count;
    $('spotKickerL').textContent = 'Question ' + q + ' — get ready';
    $('spotNameL').textContent = String(count);
    $('spotMarginL').textContent = 'BUZZERS OPEN WHEN THE COUNT HITS ZERO';
    setQ(q);
  }
  function renderLan(teams, state) {
    if (!state) return;
    $('teamCountL').textContent = teams.length + ' TEAMS';
    $('buzzCountL').textContent = state.buzzes && state.buzzes.length ? (state.buzzes.length + ' IN') : '';
    if (state.countdown && state.countdown.active) {
      var remain = Math.max(0, (state.countdown.endsAt || Date.now()) - Date.now());
      renderCountdown(Math.min(3, Math.max(1, Math.ceil((remain + 60) / 1000))), state.questionNo);
    } else {
      var w = $('stateWordL');
      w.classList.toggle('live', !!state.armed);
      w.classList.toggle('locked', !state.armed);
      w.textContent = state.armed ? 'LIVE' : 'LOCKED';
      $('stateSubL').textContent = state.armed ? 'Accepting presses' : 'Awaiting arm';
      setQ(state.questionNo);
      var win = (state.buzzes || [])[0] || null;
      if (!win) {
        $('spotKickerL').textContent = state.armed ? ('Question ' + state.questionNo + ' — open') : 'Standby';
        $('spotNameL').textContent = 'Awaiting first buzz';
        $('spotMarginL').textContent = state.armed ? 'BUZZERS LIVE — FIRST VALID PRESS TAKES P1' : 'ARM THE BUZZER TO OPEN THE QUESTION';
      } else {
        $('spotKickerL').textContent = 'Question ' + state.questionNo + ' — first buzz';
        $('spotNameL').textContent = win.teamName;
        $('spotMarginL').textContent = 'MARGIN +0 MS · CORRECTED · LINK ' + (win.rtt == null ? '–' : win.rtt) + ' MS';
        if (win.teamId !== lastWinnerId) lastWinnerId = win.teamId;
      }
    }
    $('rankBodyL').innerHTML = (state.buzzes || []).map(function (b) {
      return '<tr><td class="pos">P' + b.rank + '</td><td><span class="tchip" style="background:' + esc(b.color) + '"></span>' + esc(b.teamName) + '</td>'
        + '<td class="num">' + new Date(b.adjustedTime).toLocaleTimeString() + '</td>'
        + '<td class="tmargin">' + (b.deltaMs === 0 ? '+0 — P1' : '+' + b.deltaMs) + '</td>'
        + '<td class="num">' + (b.rtt == null ? '–' : b.rtt) + ' ms</td></tr>';
    }).join('');
    $('rosterL').innerHTML = teams.map(function (t) {
      return '<div class="rrow" style="--c:' + esc(t.color) + '"><span class="bar"></span><span class="nm">' + esc(t.name) + '</span>'
        + '<span class="st in">IN</span><button class="rm" data-kick="' + esc(t.id) + '">×</button></div>';
    }).join('');
  }

  function wire() {
    var arm = $('armBtnL'); if (arm) arm.onclick = function () { control('arm'); };
    var lock = $('lockBtnL'); if (lock) lock.onclick = function () { control('lock'); };
    var next = $('nextBtnL'); if (next) next.onclick = function () { control('next'); };
    var reset = $('resetBtnL'); if (reset) reset.onclick = function () { control('reset'); };
    var pres = $('presentBtnL');
    if (pres) pres.onclick = function () {
      var on = !document.body.classList.contains('present');
      document.body.classList.toggle('present', on);
      pres.textContent = on ? 'Console' : 'Present';
      toast(on ? 'Present mode — Esc to exit' : 'Console mode');
    };
    var cp = $('copyBtnL');
    if (cp) cp.onclick = function () {
      var full = $('joinLinkL').dataset.full || '';
      if (!full) return toast('Create a room first');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(full).then(function () { toast('Join link copied'); }, function () { toast('Copy failed — long-press to copy'); });
        } else toast('Copy failed — long-press to copy');
      } catch (e) { toast('Copy failed — long-press to copy'); }
    };
    var ros = $('rosterL');
    if (ros) ros.addEventListener('click', function (e) {
      var b = e.target.closest('[data-kick]');
      if (!b || !store) return;
      store.kick(b.dataset.kick);
      renderLan(store.publicTeams(), store.publicState());
    });
    // Projector privacy: hide QR codes + links (same as the Internet studio).
    var ht = $('toggleJoinVisL');
    if (ht) ht.onclick = function () {
      var sec = $('joinSecretsL'), note = $('joinMaskedNoteL');
      var hidden = sec.style.display !== 'none';
      sec.style.display = hidden ? 'none' : '';
      if (note) note.style.display = hidden ? 'block' : 'none';
      ht.textContent = hidden ? 'Show' : 'Hide';
      if (hidden) toast('Team codes hidden from projector');
    };
    var end = $('endRoomBtnL');
    if (end) end.onclick = function () {
      if (!store) return;
      if (!end.dataset.armed) {
        end.dataset.armed = '1'; end.textContent = 'Confirm end?';
        setTimeout(function () { end.dataset.armed = ''; end.textContent = 'End room'; }, 3000);
        return;
      }
      end.dataset.armed = ''; end.textContent = 'End room';
      try { store.close(); } catch (e) {}
      for (var e2 of peers.values()) { try { e2.conn.close(); } catch (err) {} }
      peers.clear();
      try { if (peer) peer.destroy(); } catch (err2) {}
      peer = null; store = null; lanCode = null;
      window.__p2pActive = false;
      document.body.classList.remove('present');
      var p = $('presentBtnL'); if (p) p.textContent = 'Present';
      $('studioLan').style.display = 'none';
      $('setup').style.display = 'block';
      var pill = $('connPill');
      if (pill) pill.innerHTML = '<span class="livedot idle"></span>Offline';
      var strip = $('roomCodeStrip'); if (strip) strip.textContent = '— — — — —';
      toast('LAN room closed');
    };
    document.addEventListener('keydown', function (e) {
      var st = $('studioLan');
      if (!st || st.style.display === 'none') return;
      if (/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        var live = $('stateWordL').classList.contains('live');
        control(live ? 'lock' : 'arm');
      } else if (e.key === 'n' || e.key === 'N') control('next');
      else if (e.key === 'r' || e.key === 'R') control('reset');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.BuzzLanHost = { createRoom: createRoom };
})();
