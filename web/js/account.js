/*
 * Who is signed in. Asks /api/me once (and not at all when the server's settings say sign-in is off), fills the
 * header's account slot when the page has one, and tells the page scripts that subscribed when the answer changes.
 *
 * window.Account: load() resolves the last answer that could be read ({signin, user, agentKey}), or null only
 * before the first one; current() is that answer, without waiting; refresh() asks again and, when it got an answer, tells every onChange listener (a failed
 * refresh tells nobody and keeps the last answer, so a page never goes back to "unknown"); onChange(fn) adds a listener.
 * The connect page subscribes, to follow a sign-out and the key panel. The start page has no slot and no listener:
 * it only reads load() once. The slot is a sibling of the main nav: empty and hidden with sign-in off, a sign-in link
 * when signed out, and "Signed in as ..." with a Sign out button when signed in. Wording comes from account-view.js.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var AccountView = window.AccountView;
  var html = UI.html;

  var listeners = [];
  var pending = null;
  var last = null; // the last good answer
  var OFF = { signin: 'off', user: null, agentKey: null };

  // The answer from the server, or null when it couldn't be read. With sign-in off there is nobody to ask about.
  function fetchMe() {
    return UI.loadConfig().then(function (config) {
      if (config && config.signin === 'off') return OFF;
      return UI.request('GET', '/api/me').then(function (res) { return res.ok ? AccountView.parseMe(res.data) : null; });
    });
  }

  // Every question gets a number, and an answer is used only if it is newer than the last one used: two questions
  // in flight can come back in either order, and the older one must not undo the newer.
  var issued = 0;
  var applied = 0;

  // Asks the server. Resolves whether the answer was used (it could be read, and no newer one had been used).
  function ask() {
    var seq = ++issued;
    return fetchMe().then(function (me) {
      if (!me || seq < applied) return false;
      applied = seq;
      last = me;
      return true;
    });
  }

  // The last answer that could be read, once there is one; until then the first question is asked once, however often this is
  // called, and a failed read is not remembered, so the next call tries again.
  function load() {
    if (last) return Promise.resolve(last);
    if (!pending) pending = ask().then(function () { pending = null; return last; });
    return pending;
  }

  function current() { return last; }

  function refresh() {
    return ask().then(function (used) {
      if (!used) return last; // could not read it, or a newer answer is already in: nothing changes
      listeners.forEach(function (fn) { fn(last); });
      return last;
    });
  }

  function onChange(fn) { listeners.push(fn); }

  // ---------- header slot ----------

  function signOut(button) {
    UI.setBusy(button, true);
    UI.request('POST', '/auth/logout', {}).then(function (res) {
      if (res.ok) UI.toast(AccountView.SIGNED_OUT, 'ok');
      else UI.toast(AccountView.errorMessage('logout', res.status, res.data.code), 'warn');
      // The server clears the cookie even when it couldn't finish saving, so the slot asks again whatever happened.
      return refresh().then(function () {
        UI.setBusy(button, false);
        // The button is gone with the sign-in: focus goes to what replaced it, never to the page.
        var next = UI.byId('account-signin') || UI.byId('sign-out');
        if (next) next.focus();
      });
    });
  }

  function renderSlot(me) {
    var el = UI.byId('account-slot');
    if (!el || !me) return;
    var d = AccountView.slot(me, location.pathname);
    if (!d) {
      UI.render(el, html``);
      el.hidden = true;
      return;
    }
    if (d.kind === 'signed-out') {
      UI.render(el, html`<a class="site-header__account-link" id="account-signin" href="${UI.url(d.href)}">${d.text}</a>`);
    } else {
      UI.render(el, html`<span class="site-header__account-who">${d.text}</span><button class="btn btn--link" type="button" id="sign-out">${d.signOut}</button>`);
      var button = UI.byId('sign-out');
      button.addEventListener('click', function () { signOut(button); });
    }
    el.hidden = false;
  }

  onChange(renderSlot);
  load().then(renderSlot);

  window.Account = { load: load, current: current, refresh: refresh, onChange: onChange };
})();
