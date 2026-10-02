/* Applies the stored theme before first paint. Load synchronously in <head>. */
(function () {
  try {
    var t = localStorage.getItem('ui-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage unavailable: follow the system theme */ }
})();
