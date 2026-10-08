/*
 * Who is signed in. Asks /api/me once, in parallel with the server's settings (with sign-in off the settings decide and its answer is ignored), fills the
 * header's account slot when the page has one, and tells the page scripts that subscribed when the answer changes.
 *
 * window.Account: load() resolves the last answer that could be read ({signin, user, agentKeys}), or null only
 * before the first one; current() is that answer, without waiting; refresh() asks again and, when it got an answer, tells every onChange listener (a failed
 * refresh tells nobody and keeps the last answer, so a page never goes back to "unknown"); onChange(fn) adds a listener.
 * The connect page subscribes, to follow a sign-out and the key panel. The start page has no slot and no listener:
 * it only reads load() once. The slot is a sibling of the main nav: it holds the signed-out sign-in link in the page's own markup (so it shows at once, and a test
 * holds that markup to account-view.js), is emptied and hidden with sign-in off, keeps the link when signed out, and "Signed in as ..." with a Sign out button when signed in. Wording comes from account-view.js.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var AccountView = window.AccountView;
  var html = UI.html;

  var listeners = [];
  var pending = null;
  var last = null; // the last good answer
  var OFF = { signin: 'off', user: null, agentKeys: [] };

  // The answer from the server, or null when it couldn't be read. With sign-in off there is nobody to ask about.
  // /api/me is asked at once, in parallel with the settings: asking one after the other doubled the wait before the start page
  // could show its sign-in prompt. The settings decide: with sign-in off the answer is OFF as soon as they say so, without
  // waiting for /api/me, whose reply is then ignored.
  function fetchMe() {
    var me = UI.request('GET', '/api/me');
    return UI.loadConfig().then(function (config) {
      if (config && config.signin === 'off') return OFF;
      return me.then(function (res) { return res.ok ? AccountView.parseMe(res.data) : null; });
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
      // The page already holds this button (static markup, so it shows with the page): keep it, and only point it back at this page.
      var present = UI.byId('account-signin');
      if (present) {
        present.setAttribute('href', UI.url(d.href));
        el.hidden = false;
        return;
      }
      // One of the two labels is display:none at any width, so a screen reader hears only the one on screen.
      UI.render(el, html`<a class="btn btn--secondary btn--small" id="account-signin" href="${UI.url(d.href)}">${UI.icon('github')}<span class="site-header__account-long">${d.text}</span><span class="site-header__account-short">${d.short}</span></a>`);
    } else {
      UI.render(el, html`<span class="site-header__account-who">${d.hint ? html`<span class="sr-only">${d.hint}</span>` : false}<span class="site-header__account-login">${d.who}</span></span><button class="btn btn--link" type="button" id="sign-out">${d.signOut}</button>`);
      var button = UI.byId('sign-out');
      button.addEventListener('click', function () { signOut(button); });
    }
    el.hidden = false;
  }

  onChange(renderSlot);
  load().then(renderSlot);

  window.Account = { load: load, current: current, refresh: refresh, onChange: onChange };
})();
