// Applies the stored theme before first paint (external file so the CSP can stay strict).
(function () {
  try {
    var pref = localStorage.getItem('oriel:theme') || 'system';
    var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    // High contrast (navigation module).
    if (localStorage.getItem('oriel:contrast') === 'high') document.documentElement.setAttribute('data-contrast', 'high');
  } catch (e) {}
})();
