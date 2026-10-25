// Apply the saved theme before first paint. "auto" (or nothing saved) follows the system
// setting through CSS; only an explicit choice sets data-theme. Storage can throw in
// privacy modes and sandboxed frames, so every access is guarded.
(function () {
  try {
    const mode = window.localStorage.getItem('filesync.theme');
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
  } catch (e) { /* follow the system setting */ }
})();
