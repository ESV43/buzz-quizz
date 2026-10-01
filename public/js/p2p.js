/* QSI Buzz — browser-host P2P core (Mini Militia model).
 *
 * Goal: no `npm install`, no laptop-as-Node-server. Everyone loads the site
 * from Vercel (internet, once). The HOST's browser tab becomes the timing
 * authority via WebRTC DataChannels (PeerJS cloud = signaling only).
 * When host + players share event Wi-Fi, ICE connects directly over the LAN
 * so buzz packets never leave the room (~5-20ms). Internet (TURN relay) is
 * the automatic fallback when the venue AP isolates clients.
 *
 * Room codes stay 5 chars. Peer IDs are `qsi-buzz-<CODE>` on the public
 * PeerJS cloud — no backend to run.
 *
 * Message envelope (JSON over DataConnection):
 *   { t: '<event>', ...payload, _id: '<reqId>' }  — requests expect
 *   { t: '<event>:ack', _id, ok, ... }            — ack from host.
 * Broadcasts from host: room-update / buzz-update / control-event /
 *   kicked / room-closed / security-alert / focus-alert
 */
(function () {
  'use strict';

  var PEER_PREFIX = 'qsi-buzz-';
  var PEER_CDN = 'https://unpkg.com/peerjs@1.5.3/dist/peerjs.min.js';

  function roomToPeerId(code) {
    return PEER_PREFIX + String(code || '').toUpperCase().trim();
  }
  function peerIdToRoom(pid) {
    pid = String(pid || '');
    if (pid.indexOf(PEER_PREFIX) === 0) return pid.slice(PEER_PREFIX.length);
    return '';
  }
  function makeRoomCode() {
    var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var s = '';
    for (var i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function makePin(digits) {
    digits = digits || 4;
    var s = '';
    for (var i = 0; i < digits; i++) s += String(Math.floor(Math.random() * 10));
    return s;
  }

  /** Load PeerJS from CDN on demand (page itself already came from Vercel). */
  function ensurePeerJs() {
    if (window.Peer) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = PEER_CDN;
      s.onload = function () { resolve(!!window.Peer); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }

  /**
   * Open a DataConnection wrapper with request/ack semantics.
   * conn: PeerJS DataConnection (reliable, ordered).
   * onMessage(msg, reply): handler; reply(payload) sends `<t>:ack`.
   */
  function wrapConn(conn, onMessage) {
    var pending = new Map();
    var seq = 0;
    conn.on('data', function (msg) {
      if (!msg || typeof msg !== 'object') return;
      // Ack for our request?
      if (msg._ack && pending.has(msg._id)) {
        var r = pending.get(msg._id);
        pending.delete(msg._id);
        clearTimeout(r.timer);
        r.resolve(msg);
        return;
      }
      // Incoming request — reply via closure.
      var replied = false;
      var reply = function (payload) {
        if (replied) return;
        replied = true;
        try { conn.send(Object.assign({ _ack: true, _id: msg._id, t: (msg.t || 'msg') + ':ack' }, payload || {})); } catch (e) {}
      };
      // Fire-and-forget broadcasts have no _id.
      try { onMessage && onMessage(msg, reply); } catch (e) {}
      if (!msg._id && !replied) { /* broadcast, nothing to ack */ }
      else if (msg._id && !replied) reply({ ok: true });
    });
    function request(t, payload, timeoutMs) {
      return new Promise(function (resolve) {
        var id = 'q' + (++seq) + '_' + Date.now().toString(36);
        var timer = setTimeout(function () {
          pending.delete(id);
          resolve({ ok: false, error: 'Host not answering — same Wi-Fi? Host tab open?' });
        }, Math.max(1000, Math.min(12000, timeoutMs || 8000)));
        pending.set(id, { resolve: resolve, timer: timer });
        try { conn.open ? null : null; } catch (e) {}
        try { conn.send(Object.assign({ t: t, _id: id }, payload || {})); }
        catch (e) { clearTimeout(timer); pending.delete(id); resolve({ ok: false, error: 'Send failed — retry' }); }
      });
    }
    function send(t, payload) {
      try { conn.send(Object.assign({ t: t }, payload || {})); } catch (e) {}
    }
    return { conn: conn, request: request, send: send };
  }

  window.BuzzP2P = {
    PEER_PREFIX: PEER_PREFIX,
    roomToPeerId: roomToPeerId,
    peerIdToRoom: peerIdToRoom,
    makeRoomCode: makeRoomCode,
    makePin: makePin,
    ensurePeerJs: ensurePeerJs,
    wrapConn: wrapConn,
  };
})();
