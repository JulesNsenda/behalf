/*
 * Protocol page: the full specification loads the first time the disclosure is opened, and is
 * rendered by markdown.js (which takes UI and returns UI.html output for UI.render).
 */
(function () {
  'use strict';

  var disclosure = UI.byId('spec-disclosure');
  var target = UI.byId('spec-text');
  var status = UI.byId('spec-status');
  var started = false;

  function load() {
    started = true;
    UI.setBusy(target, true);
    UI.render(status, UI.html`<p>Loading the specification…</p>`);
    fetch('/spec/SPEC.md').then(function (r) {
      if (!r.ok) throw new Error('status ' + r.status);
      return r.text();
    }).then(function (text) {
      UI.render(target, Markdown.render(text, UI));
      UI.render(status, UI.html``);
      UI.setBusy(target, false);
    }).catch(function () {
      started = false;
      UI.setBusy(target, false);
      UI.render(status, UI.html`<p>Couldn’t load the specification. Close this and open it again to retry, or <a href="/spec/SPEC.md">read it as plain text</a>.</p>`);
    });
  }

  disclosure.addEventListener('toggle', function () {
    if (disclosure.open && !started) load();
  });
})();
