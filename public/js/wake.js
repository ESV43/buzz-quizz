/* Buzz Arena shared stay-awake — WakeLock + looping-video double layer.
 * Used by play / host / companion. Works on https (WakeLock) AND plain-LAN
 * http (video fallback). Best-effort: browsers/OS can still force sleep, so
 * callers should surface mode() in UI and advise https + OS "never sleep".
 *
 * Usage: <script src="/js/wake.js?v=2"></script> then
 *   BuzzWake.keepAwake(); BuzzWake.kickVideo();
 *   BuzzWake.onChange((mode) => ...); // 'lock' | 'video' | 'pending' | 'none'
 *   BuzzWake.wantsTap(); // true when playback is gesture-blocked: show a
 *   // TAP button — the tap itself is the user activation play() needs.
 */
(function () {
  'use strict';
  var sentinel = null;
  var retryT = null;
  var retryN = 0;
  var releases = 0;
  var video = null;
  var videoOn = false;
  var needsGesture = false; // play() rejected for lack of user activation
  var listeners = [];
  var lastTap = 0;

  function wakeApi() { return 'wakeLock' in navigator; }

  function mode() {
    if (sentinel && !sentinel.released) return 'lock';
    if (videoOn) return 'video';
    return wakeApi() ? 'pending' : 'none';
  }

  function notify() {
    var m = mode();
    var info = { wantsTap: needsGesture };
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](m, releases, info); } catch (e) {}
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function wantsTap() { return needsGesture; }

  /* ---- video layer: always built, always playing when visible ---- */
  function ensureVideo() {
    if (video || !document.body) return video;
    try {
      var v = document.createElement('video');
      v.muted = true;
      v.loop = true;
      v.autoplay = true;
      v.preload = 'auto';
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.setAttribute('x-webkit-airplay', 'deny');
      try { v.setAttribute('disablepictureinpicture', ''); } catch (e) {}
      try { v.disablePictureInPicture = true; } catch (e) {}
      // 64px + barely-visible (NOT display:none / 2px): some browsers pause
      // or refuse to hold a display lock for sub-visible media.
      v.style.cssText = 'position:fixed;right:0;bottom:0;width:64px;height:64px;'
        + 'opacity:0.01;pointer-events:none;z-index:2147483647;';
      v.setAttribute('aria-hidden', 'true');
      v.tabIndex = -1;
      var s = document.createElement('source');
      s.src = '/nosleep.mp4';
      s.type = 'video/mp4';
      v.appendChild(s);
      document.body.appendChild(v);
      video = v;
      v.addEventListener('playing', function () {
        if (!videoOn) { videoOn = true; }
        if (needsGesture) { needsGesture = false; }
        notify();
      });
      var resumeT1 = null, resumeT2 = null;
      var lost = function () {
        if (videoOn) { videoOn = false; notify(); }
        // resume ASAP — pause/ended during an event is how screens die.
        // An immediate retry often fails while the OS is still settling, so
        // also retry on delays: a late success still beats the next timeout.
        kickVideo();
        try { clearTimeout(resumeT1); clearTimeout(resumeT2); } catch (e) {}
        resumeT1 = setTimeout(function () { if (!document.hidden) kickVideo(); }, 1000);
        resumeT2 = setTimeout(function () { if (!document.hidden) kickVideo(); }, 4000);
      };
      v.addEventListener('pause', lost);
      v.addEventListener('ended', lost);
      v.addEventListener('waiting', function () { kickVideo(); });
      v.addEventListener('stalled', function () { kickVideo(); });
      // reload source if it errors (e.g. first load raced the server)
      v.addEventListener('error', function () {
        setTimeout(function () {
          try { v.load(); kickVideo(); } catch (e) {}
        }, 2000);
      }, true);
      kickVideo();
    } catch (e) {}
    return video;
  }

  function kickVideo() {
    if (!document.body) return;
    if (!video) ensureVideo();
    if (!video) return;
    if (document.hidden) return;
    try {
      if (video.paused || video.ended) {
        var p = video.play();
        if (p && p.catch) p.catch(function (err) {
          // No user activation yet (autoplay policy): timer retries can never
          // clear this — only a real tap can. Flag it so the page can show a
          // TAP button; the tap itself is the activation play() needs.
          var blocked = err && (err.name === 'NotAllowedError' || err.name === 'NotSupportedError');
          if (blocked && !needsGesture) { needsGesture = true; notify(); }
        });
      } else if (needsGesture) {
        needsGesture = false; notify();
      }
    } catch (e) {}
  }

  /* ---- WakeLock layer ---- */
  function clearRetry() { if (retryT) { clearTimeout(retryT); retryT = null; } }

  function scheduleRetry(ms) {
    clearRetry();
    retryT = setTimeout(function () {
      retryT = null;
      keepAwake();
    }, ms);
  }

  async function keepAwake() {
    ensureVideo();
    kickVideo();
    if (document.hidden) return mode();
    if (!wakeApi()) { notify(); return mode(); }
    if (sentinel && !sentinel.released) return mode();
    try {
      sentinel = await navigator.wakeLock.request('screen');
      retryN = 0;
      notify();
      sentinel.addEventListener('release', function () {
        sentinel = null;
        releases += 1;
        notify();
        // reclaim fast — must beat the shortest OS screen timeout (15s)
        if (!document.hidden) scheduleRetry(1200);
      });
    } catch (e) {
      sentinel = null;
      retryN = Math.min(retryN + 1, 6);
      notify();
      // video layer already covers us; keep hammering the lock in background
      // (transient denials clear on next gesture / visibility return)
      scheduleRetry(Math.min(2000 * Math.max(1, retryN), 12000));
      // belt + suspenders: make sure the video is rolling when lock refuses
      kickVideo();
    }
    return mode();
  }

  /* ---- wiring: every natural gesture + fast poll ---- */
  function gesture() {
    ensureVideo();
    kickVideo();
    var now = Date.now();
    if (now - lastTap < 15000) return;
    lastTap = now;
    keepAwake();
  }

  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, gesture, { passive: true });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      keepAwake();
      // iOS sometimes needs a beat after foregrounding before play() sticks
      setTimeout(kickVideo, 300);
      setTimeout(kickVideo, 1200);
    }
  });
  window.addEventListener('focus', function () { keepAwake(); });
  window.addEventListener('pageshow', function () { keepAwake(); setTimeout(kickVideo, 300); });
  window.addEventListener('online', function () { keepAwake(); });

  // Poll faster than the shortest common screen timeout (15s) so a silently
  // released lock / paused video is reclaimed before the display can sleep.
  setInterval(function () {
    if (!document.hidden) { keepAwake(); kickVideo(); }
  }, 8000);

  // Build eagerly (muted autoplay may succeed without a gesture); the first
  // real tap guarantees it.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { ensureVideo(); keepAwake(); });
  } else {
    ensureVideo();
  }

  window.BuzzWake = {
    keepAwake: keepAwake,
    kickVideo: kickVideo,
    ensureVideo: ensureVideo,
    mode: mode,
    hasApi: wakeApi,
    wantsTap: wantsTap,
    get releases() { return releases; },
    onChange: onChange,
  };
})();
