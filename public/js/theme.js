/**
 * Dark/light theme toggle, shared across every page.
 *
 * The no-flash bit (setting data-theme before paint) lives inline in each
 * page's <head> — see the snippet at the top of every HTML file — so the
 * page never flashes the wrong theme on load. This file only wires up the
 * button click once the DOM is ready.
 */
(function () {
  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const now = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        apply(now);
        try { localStorage.setItem('lcb_theme', now); } catch (e) {}
      });
    });
  });
})();
