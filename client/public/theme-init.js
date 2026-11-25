// Runs synchronously before first paint so the saved theme is applied without a flash.
// Keep the logic in sync with src/context/ThemeContext.jsx. Only the theme name is stored.
(function () {
  var theme = 'light';
  try {
    var stored = window.localStorage.getItem('bookstore_theme');
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      theme = 'dark';
    }
  } catch (e) {
    /* storage unavailable: fall back to light */
  }
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.classList.add(theme === 'dark' ? 'cds--g100' : 'cds--white');
})();
