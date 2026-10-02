/*
 * Home page: starts the scripted demo and shows a note when the server has no built-in AI.
 * Every dynamic piece of markup goes through UI.html and UI.render, and error wording comes from room-view.js.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var RoomView = window.RoomView;
  var Links = window.Links;
  var html = UI.html;

  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-demo]'));
  var errorBox = UI.byId('demo-error');
  var starting = false;

  function showError(message) { UI.render(errorBox, UI.alertBox(message, 'danger')); }

  function setBusy(busy) {
    starting = busy;
    UI.setBusy(buttons, busy);
  }

  function startDemo() {
    if (starting) return;
    setBusy(true);
    UI.render(errorBox, html``);
    UI.request('POST', '/api/demo', {}).then(function (res) {
      // A good answer has the room's id and the creator's token. Anything else is a failure, even a 200.
      var to = res.ok ? Links.demoUrl(res.data) : null;
      if (to) {
        location.href = UI.url(to);
        return;
      }
      setBusy(false);
      showError(RoomView.errorMessage('demo', res.ok ? 500 : res.status));
    });
  }

  buttons.forEach(function (b) { b.addEventListener('click', startDemo); });

  UI.loadConfig().then(function (c) {
    if (c && !c.live) UI.byId('no-ai-note').hidden = false;
  });
})();
