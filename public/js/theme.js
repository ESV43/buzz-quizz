/* Shared Sequoia light/dark theme. No protocol changes. */
(function () {
  const KEY = 'buzz-theme';
  function current() {
    try {
      const q = new URLSearchParams(location.search).get('theme');
      if (q === 'light' || q === 'dark') return q;
      return localStorage.getItem(KEY) || 'dark';
    } catch { return 'dark'; }
  }
  function paint() {
    const t = current();
    document.body.classList.toggle('light', t === 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#f5f5f7' : '#0a0c0e');
    document.querySelectorAll('[data-theme-btn]').forEach((b) => {
      b.textContent = t === 'light' ? 'Dark' : 'Light';
      b.setAttribute('aria-label', 'Toggle light mode');
      b.title = t === 'light' ? 'Switch to dark' : 'Switch to Sequoia light';
    });
  }
  function toggle() {
    const next = current() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch {}
    paint();
  }
  document.addEventListener('DOMContentLoaded', () => {
    paint();
    document.querySelectorAll('[data-theme-btn]').forEach((b) =>
      b.addEventListener('click', toggle));
  });
  window.BuzzTheme = { toggle, paint, current };
})();
