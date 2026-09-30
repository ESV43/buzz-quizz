/* Buzz Arena — LAN mode shared helper (no dependencies, load before io usage).
 *
 * Problem it solves: the Vercel-hosted page is https on the internet, while the
 * zero-delay timing server is http on event Wi-Fi (e.g. http://192.168.1.5:3000).
 * Browsers BLOCK https pages from socket/fetch to http (mixed content), so the
 * correct LAN path is a one-tap *navigation* to the LAN URL — after that every
 * buzzer packet stays on the LAN and never touches the internet.
 *
 * Conventions:
 *  - ?server=192.168.1.5:3000 (or full http://…:3000) pre-fills + saves the host.
 *  - localStorage 'buzz-lan-server' = 'http://<ip>:<port>' (or https backend).
 *  - localStorage 'buzz-lan-mode' = 'lan' | 'internet'.
 *  - After redirecting onto the LAN origin, ?server= is unnecessary (same-origin
 *    socket) but harmless — it is kept so QR/back-links keep working.
 */
(function () {
  'use strict';

  var LS_SERVER = 'buzz-lan-server';
  var LS_MODE = 'buzz-lan-mode';

  function qs() {
    try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); }
  }

  /** '192.168.1.5:3000' | 'http://192.168.1.5:3000' | 'https://x.onrender.com' -> canonical origin or null. */
  function normalizeServer(input) {
    if (input == null) return null;
    var s = String(input).trim();
    if (!s) return null;
    // strip wrapping quotes/angle brackets users paste from chat apps
    s = s.replace(/^[<"'`]+|[>"'`\s]+$/g, '').trim();
    if (!s) return null;
    // bare 'server=192.168.1.5:3000/play.html?room=X' — keep only host part
    s = s.split(/[?#]/)[0].replace(/\/+$/, '');
    var proto = null;
    var m = /^([a-z]+):\/\/(.*)$/i.exec(s);
    if (m) { proto = m[1].toLowerCase(); s = m[2]; }
    // drop any path after host:port
    s = s.split('/')[0];
    if (!s || /[\s]/.test(s)) return null;
    var host = s, port = '';
    // [v6]:port or host:port (last colon = port if numeric)
    var cm = /^(.*):(\d{1,5})$/.exec(s);
    if (cm) { host = cm[1]; port = cm[2]; }
    if (!host) return null;
    var isHttpsHost = /\.vercel\.app$|\.onrender\.com$|\.trycloudflare\.com$|\.ngrok/i.test(host);
    if (!proto) proto = isHttpsHost ? 'https' : 'http';
    if (proto !== 'http' && proto !== 'https') return null;
    // plain hostnames/IPs: default LAN port 3000 when no port given
    if (!port) port = proto === 'http' ? '3000' : '';
    // validate port
    if (port) {
      var p = parseInt(port, 10);
      if (!(p >= 1 && p <= 65535)) return null;
    }
    // validate host loosely (IPv4 / hostname / v6 bracket)
    if (!/^[A-Za-z0-9.\-_[\]:]+$/.test(host)) return null;
    if (/^https?:$/i.test(host)) return null;
    var origin = proto + '://' + host + (port ? ':' + port : '');
    try {
      var u = new URL(origin);
      return u.origin;
    } catch { return null; }
  }

  function getSavedServer() {
    try { return localStorage.getItem(LS_SERVER) || ''; } catch { return ''; }
  }
  function setSavedServer(origin) {
    try {
      if (origin) localStorage.setItem(LS_SERVER, origin);
      else localStorage.removeItem(LS_SERVER);
    } catch {}
  }
  function getSavedMode() {
    try { return localStorage.getItem(LS_MODE) || ''; } catch { return ''; }
  }
  function setSavedMode(mode) {
    try {
      if (mode) localStorage.setItem(LS_MODE, mode);
      else localStorage.removeItem(LS_MODE);
    } catch {}
  }

  /** Server explicitly requested via ?server= (canonical origin) or ''. */
  function serverFromQuery() {
    var q = qs();
    var raw = q.get('server') || q.get('lanServer') || q.get('host');
    var n = normalizeServer(raw);
    if (n) {
      setSavedServer(n);
      setSavedMode(n.indexOf('https://') === 0 ? 'internet' : 'lan');
    }
    return n || '';
  }

  /** Active timing-server origin: ?server= wins, else saved, else '' (= this page origin). */
  function activeServer() {
    var q = serverFromQuery();
    if (q) return q;
    var saved = getSavedServer();
    var norm = normalizeServer(saved);
    return norm || '';
  }

  function isHttpsPage() {
    try { return location.protocol === 'https:'; } catch { return false; }
  }
  /** https page -> http server is blocked by browsers (mixed content). Must navigate instead. */
  function isBlockedByMixedContent(serverOrigin) {
    if (!serverOrigin) return false;
    try {
      return isHttpsPage() && new URL(serverOrigin).protocol === 'http:';
    } catch { return false; }
  }
  function isSameOrigin(serverOrigin) {
    if (!serverOrigin) return true;
    try { return new URL(serverOrigin).origin === location.origin; } catch { return false; }
  }

  /** Build a URL on the LAN server, e.g. buildLanUrl(origin,'play.html','ABCDE'). */
  function buildLanUrl(serverOrigin, page, roomCode, extra) {
    var base = normalizeServer(serverOrigin);
    if (!base) return null;
    var url = base + '/' + String(page || 'play.html').replace(/^\//, '');
    var parts = [];
    if (roomCode) parts.push('room=' + encodeURIComponent(String(roomCode).toUpperCase().trim()));
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] != null && extra[k] !== '') {
          parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(extra[k])));
        }
      }
    }
    return url + (parts.length ? '?' + parts.join('&') : '');
  }

  /** Navigate to the LAN server (full page load — this is what dodges mixed-content). */
  function goLan(serverOrigin, page, roomCode, extra) {
    var url = buildLanUrl(serverOrigin, page, roomCode, extra);
    if (url) location.href = url;
    return url;
  }

  /** GET <origin>/health with timeout — null when blocked/unreachable (never throws). */
  async function testServer(serverOrigin, timeoutMs) {
    var base = normalizeServer(serverOrigin);
    if (!base) return { ok: false, error: 'Enter the host address, e.g. 192.168.1.20:3000' };
    if (isBlockedByMixedContent(base)) {
      return { ok: false, blocked: true, error: 'This internet page cannot probe a http:// LAN host — use “Open LAN version” below.' };
    }
    var to = Math.max(500, Math.min(10000, timeoutMs || 3000));
    var ctrl = null, timer = null;
    try {
      ctrl = new AbortController();
      timer = setTimeout(function () { try { ctrl.abort(); } catch {} }, to);
      var t0 = (performance && performance.now) ? performance.now() : Date.now();
      var r = await fetch(base + '/health', { cache: 'no-store', signal: ctrl.signal });
      var ms = Math.round(((performance && performance.now) ? performance.now() : Date.now()) - t0);
      if (!r.ok) return { ok: false, error: 'Host answered ' + r.status + ' — is node server.js running?' };
      return { ok: true, ms: ms };
    } catch (e) {
      var msg = (e && e.name === 'AbortError') ? 'No answer in ' + Math.round(to / 1000) + 's — same Wi-Fi? IP correct? Server running?' : 'Unreachable — same Wi-Fi? IP correct? Server running?';
      return { ok: false, error: msg };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Create the socket.io client honouring LAN mode.
   *  - Same origin (or no override): io(opts)
   *  - Cross-origin allowed (https->https, http->http): io(serverOrigin, opts)
   *  - Blocked (https->http): returns { socket: null, blocked, server } so the
   *    caller shows the "Open LAN version" redirect instead of a dead socket.
   */
  function connectSocket(ioOpts) {
    var server = activeServer();
    if (!server || isSameOrigin(server)) return { socket: io(ioOpts || {}), server: '', sameOrigin: true };
    if (isBlockedByMixedContent(server)) return { socket: null, blocked: true, server: server };
    return { socket: io(server, ioOpts || {}), server: server, sameOrigin: false };
  }

  /** Ensure window.io exists: same-origin script failed (Vercel static) -> CDN. Returns promise<bool>. */
  function ensureIo(cdnVersion) {
    if (window.io) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'https://cdn.socket.io/' + (cdnVersion || '4.7.5') + '/socket.io.min.js';
      s.onload = function () { resolve(!!window.io); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }

  window.BuzzLan = {
    normalizeServer: normalizeServer,
    serverFromQuery: serverFromQuery,
    activeServer: activeServer,
    getSavedServer: function () { return normalizeServer(getSavedServer()) || ''; },
    setSavedServer: function (raw) { var n = normalizeServer(raw); setSavedServer(n || ''); return n || ''; },
    getSavedMode: getSavedMode,
    setSavedMode: setSavedMode,
    isBlockedByMixedContent: isBlockedByMixedContent,
    isSameOrigin: isSameOrigin,
    isHttpsPage: isHttpsPage,
    buildLanUrl: buildLanUrl,
    goLan: goLan,
    testServer: testServer,
    connectSocket: connectSocket,
    ensureIo: ensureIo,
  };
})();
