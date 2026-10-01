/* QSI Buzz — browser-host authority store.
 * Runs INSIDE the host's browser tab (host-p2p.html). Same rules as
 * server.js: latency-compensated ranking, 3-2-1 countdown, PIN companion,
 * kick/close — but state lives in the page, broadcasts go over WebRTC.
 *
 * Usage:
 *   const store = window.BuzzP2PStore.create({ maxTeams: 16, onBroadcast(fnName, payload) });
 *   store.handlePlayerJoin({ teamName, teamId, offset, rtt }, peerLabel) -> { ok, team, state }
 *   store.handleBuzz({ teamId, clientPressTime, offset, rtt, buzzId }) -> { ok, rank, deltaMs }
 *   store.control('arm'|'lock'|'reset'|'next'|'clear') -> state
 *   store.publicState() / store.publicTeams()
 */
(function () {
  'use strict';

  var TEAM_COLORS = [
    '#E5484D', '#F76B15', '#FFB224', '#46A758', '#12A594', '#0090FF',
    '#6550B9', '#B975F1', '#E93DAE', '#E8B34B', '#D6409F', '#70E1C8',
    '#8ECAFF', '#FF977D', '#D3A6FF', '#9DFFA0', '#FFC53D', '#5CE08A',
    '#7C8AFF', '#FF6B6B',
  ];

  function create(opts) {
    opts = opts || {};
    var maxTeams = Math.min(Math.max(parseInt(opts.maxTeams, 10) || 16, 8), 20);
    var onBroadcast = typeof opts.onBroadcast === 'function' ? opts.onBroadcast : function () {};
    var companionPin = (window.BuzzP2P && window.BuzzP2P.makePin(4)) || String(Math.floor(1000 + Math.random() * 9000));

    var teams = new Map(); // teamId -> team
    var buzzes = [];
    var armed = false;
    var questionNo = 0;
    var countdown = null; // { active, questionNo, endsAt }
    var timers = [];

    function publicTeams() {
      return [...teams.values()].map(function (t) {
        return { id: t.id, name: t.name, color: t.color, connected: true, away: !!t.away, rtt: t.rtt ?? null, offset: t.offset ?? null };
      });
    }
    function publicState() {
      return { armed: armed, questionNo: questionNo, buzzes: buzzes, teamCount: teams.size, countdown: countdown, serverTime: Date.now() };
    }
    function broadcast() {
      onBroadcast('room-update', { teams: publicTeams(), state: publicState() });
    }
    function broadcastBuzz() {
      onBroadcast('buzz-update', { buzzes: buzzes, armed: armed, questionNo: questionNo, countdown: countdown });
    }
    function rankBuzzes() {
      buzzes.sort(function (a, b) { return a.adjustedTime - b.adjustedTime; });
      var w = buzzes[0];
      buzzes.forEach(function (b, i) {
        b.rank = i + 1;
        b.deltaMs = w ? Math.max(0, Math.round(b.adjustedTime - w.adjustedTime)) : 0;
      });
    }
    function clearTimers() {
      timers.forEach(clearTimeout);
      timers = [];
      countdown = null;
    }

    function startCountdown() {
      clearTimers();
      questionNo += 1;
      if (questionNo < 1) questionNo = 1;
      buzzes = [];
      armed = false;
      countdown = { active: true, questionNo: questionNo, endsAt: Date.now() + 3000, serverTime: Date.now() };
      broadcast(); broadcastBuzz();
      onBroadcast('control-event', { action: 'countdown', questionNo: questionNo, count: 3, endsAt: countdown.endsAt, serverTime: Date.now() });
      [2, 1].forEach(function (count, k) {
        timers.push(setTimeout(function () {
          if (!countdown) return;
          onBroadcast('control-event', { action: 'countdown', questionNo: questionNo, count: count, endsAt: countdown.endsAt, serverTime: Date.now() });
          broadcast();
        }, (k + 1) * 1000));
      });
      timers.push(setTimeout(function () {
        countdown = null;
        buzzes = [];
        armed = true;
        broadcast(); broadcastBuzz();
        onBroadcast('control-event', { action: 'arm', questionNo: questionNo, via: 'countdown' });
      }, 3000));
    }

    function handlePlayerJoin(msg) {
      var knownId = (msg && typeof msg.teamId === 'string' && teams.has(msg.teamId)) ? msg.teamId : null;
      if (!knownId && teams.size >= maxTeams) return { ok: false, error: 'Room full (' + maxTeams + ' teams).' };
      var team;
      if (knownId) {
        team = teams.get(knownId);
        if (typeof msg.teamName === 'string' && msg.teamName.trim()) team.name = msg.teamName.trim().slice(0, 24);
        team.away = false;
      } else {
        var id = 'T' + Math.random().toString(36).slice(2, 7).toUpperCase();
        team = {
          id: id,
          name: (typeof msg.teamName === 'string' && msg.teamName.trim()) ? msg.teamName.trim().slice(0, 24) : ('Team ' + (teams.size + 1)),
          color: TEAM_COLORS[teams.size % TEAM_COLORS.length],
          away: false, rtt: null, offset: null,
        };
        teams.set(id, team);
      }
      if (typeof msg.offset === 'number') team.offset = Math.round(msg.offset);
      if (typeof msg.rtt === 'number') team.rtt = Math.round(msg.rtt);
      var out = { ok: true, team: { id: team.id, name: team.name, color: team.color }, state: publicState() };
      broadcast();
      return out;
    }

    function handleBuzz(msg) {
      if (countdown && countdown.active) return { ok: false, error: 'Get ready', retryable: false, countdown: countdown };
      if (!armed) return { ok: false, error: 'Buzzer is locked' };
      var team = teams.get(msg.teamId);
      if (!team) return { ok: false, error: 'Unknown team — rejoin' };
      var existing = buzzes.find(function (b) { return b.teamId === team.id; });
      if (existing) return { ok: true, rank: existing.rank, deltaMs: existing.deltaMs, duplicate: true };
      if (msg.buzzId && buzzes.some(function (b) { return b.buzzId === msg.buzzId; })) {
        var mine = buzzes.find(function (b) { return b.buzzId === msg.buzzId; });
        return { ok: true, rank: mine.rank, deltaMs: mine.deltaMs, duplicate: true };
      }
      var serverReceiveTime = Date.now();
      var safeOffset = (typeof msg.offset === 'number' && Math.abs(msg.offset) < 60000) ? msg.offset : (team.offset || 0);
      var press = typeof msg.clientPressTime === 'number' ? msg.clientPressTime : serverReceiveTime;
      var adjustedTime = press + safeOffset;
      if (typeof msg.rtt === 'number') team.rtt = Math.round(msg.rtt);
      team.offset = Math.round(safeOffset);
      buzzes.push({
        teamId: team.id, teamName: team.name, color: team.color,
        clientPressTime: press, offset: Math.round(safeOffset),
        serverReceiveTime: serverReceiveTime, adjustedTime: Math.round(adjustedTime),
        rtt: team.rtt, rank: null, deltaMs: null,
        buzzId: typeof msg.buzzId === 'string' ? msg.buzzId.slice(0, 64) : null,
      });
      rankBuzzes();
      var mine2 = buzzes.find(function (b) { return b.teamId === team.id; });
      var out = { ok: true, rank: mine2.rank, deltaMs: mine2.deltaMs };
      broadcast(); broadcastBuzz();
      return out;
    }

    function control(action) {
      if (action === 'arm' || action === 'next') { startCountdown(); return publicState(); }
      if (action === 'lock') { clearTimers(); armed = false; }
      else if (action === 'reset') { clearTimers(); buzzes = []; armed = false; }
      else if (action === 'clear') { buzzes = []; }
      broadcast(); broadcastBuzz();
      onBroadcast('control-event', { action: action, questionNo: questionNo });
      return publicState();
    }

    function kick(teamId) {
      if (!teams.has(teamId)) return { ok: false };
      teams.delete(teamId);
      buzzes = buzzes.filter(function (b) { return b.teamId !== teamId; });
      rankBuzzes();
      broadcast(); broadcastBuzz();
      onBroadcast('kicked', { teamId: teamId });
      return { ok: true };
    }

    // Quizmaster remote (companion-p2p.html): PIN gate, then full state +
    // control via 'companion-control'. Same PIN shown on the host screen.
    function handleCompanionJoin(msg) {
      if (String(msg && msg.pin) !== String(companionPin)) {
        return { ok: false, error: 'Wrong PIN — ask the host.' };
      }
      return { ok: true, state: publicState(), teams: publicTeams() };
    }

    function close() {
      clearTimers();
      onBroadcast('room-closed', { at: Date.now() });
    }

    return {
      handlePlayerJoin: handlePlayerJoin,
      handleBuzz: handleBuzz,
      handleCompanionJoin: handleCompanionJoin,
      control: control,
      kick: kick,
      close: close,
      publicTeams: publicTeams,
      publicState: publicState,
      get companionPin() { return companionPin; },
      get maxTeams() { return maxTeams; },
    };
  }

  window.BuzzP2PStore = { create: create };
})();
