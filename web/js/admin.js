/*
 * Admin page: who may use our AI. DOM wiring only: the wording and the choices are in admin-view.js, and the account slot in the header is
 * account.js's.
 *
 * Asks GET /api/admin/ai-access. A 404 (the server says that to everyone who is not an admin, signed in or not) is shown as a plain "not
 * available"; any other answer that is not the list is a failure with a way to try again. Each request is one row: the login, the status, when, the
 * person's own note (quoted plain text, apart from the buttons, never a link) and the decisions that make sense. A decision is a JSON POST;
 * when it is saved the list is asked for again, so the page shows what the server holds.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var AccountView = window.AccountView;
  var AdminView = window.AdminView;
  var Account = window.Account;
  var html = UI.html;

  var view = UI.byId('admin-view');
  var busy = false;
  var focusNext = null; // the id to focus after the next draw, so focus never falls to the page

  function show(safe) {
    UI.render(view, safe);
    view.removeAttribute('aria-busy');
    if (focusNext) {
      var target = UI.byId(focusNext) || UI.byId('admin-list-title');
      focusNext = null;
      if (target) target.focus();
    }
  }

  function draw(requests, notice) {
    var rows = AdminView.rows(requests);
    show(html`
      <div class="stack stack--sm">
        <h2 id="admin-list-title" class="card__title" tabindex="-1">${AdminView.LIST_TITLE}</h2>
        ${notice ? UI.alertBox(notice, 'danger') : false}
        ${rows.length ? html`<ul class="list-reset stack stack--md" id="admin-list" aria-labelledby="admin-list-title">${rows.map(function (r) {
          return html`<li class="card stack stack--sm" id="request-${r.userId}">
            <div class="cluster">
              <strong>${r.who}</strong>
              <span class="pill pill--${r.status.tone}">${r.status.label}</span>
            </div>
            ${r.dates.length ? html`<span class="text-caption">${r.dates.join('. ')}</span>` : false}
            ${r.note ? html`<div class="stack stack--sm">
              <span class="text-caption">${r.noteLabel}</span>
              <blockquote class="quote"><p class="quote__text prose">${r.note}</p></blockquote>
            </div>` : false}
            <div class="cluster">${r.actions.map(function (a) {
              return html`<button class="btn btn--secondary btn--small" type="button" id="${a.decision}-${r.userId}" aria-label="${a.name}">${a.label}</button>`;
            })}</div>
          </li>`;
        })}</ul>` : html`<p class="text-muted">${AdminView.EMPTY}</p>`}
      </div>
    `);
    rows.forEach(function (r) {
      r.actions.forEach(function (a) {
        var button = UI.byId(a.decision + '-' + r.userId);
        if (button) button.addEventListener('click', function () { decide(r, a.decision, button); });
      });
    });
  }

  function drawUnavailable() {
    var me = Account.current();
    var d = AdminView.unavailable(Boolean(me && me.user), Boolean(me && me.signin === 'off'));
    show(html`
      <div class="stack stack--sm">
        <h2 id="admin-unavailable" class="card__title" tabindex="-1">${d.title}</h2>
        <p class="text-muted">${d.lead}</p>
        <div><a class="btn btn--link btn--flush" href="${UI.url(d.homeHref)}">${d.home}</a></div>
      </div>
    `);
  }

  function drawFailed() {
    show(html`
      <div class="stack stack--sm">
        ${UI.alertBox(AdminView.LOAD_FAILED, 'danger')}
        <div><button class="btn btn--secondary" type="button" id="admin-retry">${AdminView.RETRY}</button></div>
      </div>
    `);
    UI.byId('admin-retry').addEventListener('click', function () { focusNext = 'admin-retry'; load(); });
  }

  // Asks for the list and shows it. notice, if any, is a sentence about what just went wrong, shown above it.
  // afterDecision: a 404 may mean the session ended meanwhile, so the account is asked again first and the page can ask for a sign-in.
  function load(notice, afterDecision) {
    // The account answer first, so the unavailable page knows whether to ask for a sign-in.
    return Account.load().then(function () {
      return UI.request('GET', '/api/admin/ai-access');
    }).then(function (res) {
      if (res.status === 404) return (afterDecision ? Account.refresh() : Promise.resolve()).then(drawUnavailable);
      var requests = res.ok ? AdminView.parseRequests(res.data) : null;
      if (!requests) return drawFailed();
      draw(requests, notice);
    });
  }

  function decide(r, decision, button) {
    if (busy) return;
    busy = true;
    UI.setBusy(button, true);
    UI.request('POST', '/api/admin/ai-access', { userId: r.userId, decision: decision }).then(function (res) {
      busy = false;
      UI.setBusy(button, false);
      if (res.ok) UI.toast(AdminView.decided(decision, r.who), 'ok');
      // The list is asked for again whatever happened: a refused decision may still have changed things, and a 404 means this person
      // is no longer an admin.
      focusNext = 'admin-list-title';
      return load(res.ok ? null : AdminView.errorMessage('adminDecide', res.status, (res.data || {}).code), true);
    });
  }

  load();
})();
