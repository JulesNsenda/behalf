/*
 * Connect page: fills in the connector address and the Claude Code command from the page's own
 * origin, so the page is right on any host. Copy buttons are wired by ui.js through data-copy.
 *
 * With sign-in on it also shows the agent key panel (wording from account-view.js): a sign-in link when signed
 * out, else create, show once and delete. The key is only ever in the page for as long as it is on screen: it is
 * never written into markup (copyField sets it as a property, the command takes it as text), a reload loses it, and
 * so does leaving the page (pagehide) or coming back to it from the back-forward cache (pageshow).
 * With sign-in off there is no panel and the command has no key in it.
 * What the panel shows always comes from the server's last answer (Account), never from what this page guessed:
 * after any request that got an answer the page asks again, and a key it was handed is kept only while that answer agrees.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var RoomView = window.RoomView;
  var AccountView = window.AccountView;
  var Account = window.Account;
  var html = UI.html;

  var panelEl = UI.byId('key-panel');
  var noteEl = UI.byId('command-note');
  var shown = null; // {key, createdAt} of the key just created, the only time it can be read
  var notice = null; // the sentence about what just failed, shown in the panel until the next action
  var busy = false;
  var focusNext = null; // where focus goes after the next render: 'key' (a new key) or 'action' (a button or link)

  UI.byId('mcp-url').value = RoomView.mcpUrl(location.origin);

  // The command carries the key's header only when the panel says a key is in play (commandKey: the real one just after
  // creating it, a placeholder when one exists that this page can't show).
  function setCommand(panel) {
    UI.byId('mcp-command').textContent = RoomView.mcpCommand(location.origin, panel ? panel.commandKey : null);
    var note = panel ? panel.commandNote : null;
    noteEl.textContent = note || '';
    noteEl.hidden = !note;
  }

  function render(me) {
    // "There is no sign-in." is true only with sign-in off; it stays hidden when the answer isn't known.
    UI.byId('no-signin-note').hidden = !(me && me.signin === 'off');
    var panel = AccountView.keyPanel(me, shown, location.pathname);
    setCommand(panel);
    if (!panel) {
      UI.render(panelEl, html``);
      panelEl.hidden = true;
      return;
    }
    var field = panel.field ? UI.copyField({ id: 'agent-key', label: panel.field.label, note: panel.field.note, value: shown.key, button: panel.field.button }) : null;
    UI.render(panelEl, html`
      <h2 id="key-title" class="card__title">${panel.title}</h2>
      <p class="text-muted">${panel.lead}</p>
      ${field ? field.html : false}
      ${panel.warning ? UI.callout('warn', html`<p>${panel.warning}</p>`) : false}
      ${notice ? UI.alertBox(notice, 'danger') : false}
      ${panel.signin ? html`<div><a class="btn btn--secondary" id="key-signin" href="${UI.url(panel.signin.href)}">${panel.signin.text}</a></div>` : false}
      ${panel.create ? html`<div class="cluster">
        <button class="btn btn--secondary" type="button" id="key-create">${panel.create}</button>
        ${panel.revoke ? html`<button class="btn btn--link" type="button" id="key-revoke">${panel.revoke}</button>` : false}
      </div>` : false}
    `);
    panelEl.hidden = false;
    if (field) {
      field.fill(panelEl);
      UI.byId('agent-key').setAttribute('autocomplete', 'off'); // keep the key out of any form history
    }
    var create = UI.byId('key-create');
    if (create) create.addEventListener('click', function () { act('keyCreate', create, makeKey); });
    var revoke = UI.byId('key-revoke');
    if (revoke) revoke.addEventListener('click', function () { act('keyRevoke', revoke, deleteKey); });
    // Focus never falls to the page: the key field right after creating one, else the panel's own control.
    var want = focusNext;
    focusNext = null;
    var target = want === 'key' && field ? UI.byId('agent-key') : want ? create || UI.byId('key-signin') : null;
    if (target) target.focus();
  }

  function makeKey() { return UI.request('POST', '/api/me/agent-key', {}); }

  function deleteKey() { return UI.request('POST', '/api/me/agent-key/revoke', {}); }

  // One request at a time. Whatever answer comes back, the page asks the server again and shows that: a refusal can
  // still have changed things (creating a key puts the old one out first, and a 401 means the session is gone). Only
  // a network failure gets no answer, and then the page stays as it was.
  function act(action, button, send) {
    if (busy) return;
    busy = true;
    notice = null;
    UI.setBusy(button, true);
    send().then(function (res) {
      busy = false;
      focusNext = 'action';
      if (res.status === 0) { // no answer at all: the page stays as it was, with what went wrong said
        notice = AccountView.errorMessage(action, 0);
        return render(Account.current());
      }
      if (res.ok && action === 'keyCreate') {
        var key = res.data && res.data.key;
        if (typeof key === 'string' && AccountView.KEY_PATTERN.test(key)) {
          shown = { key: key, createdAt: res.data.createdAt };
          focusNext = 'key';
        } else {
          // A 201 with something else in it is not a key: say so rather than show it.
          shown = null;
          notice = AccountView.errorMessage('keyCreate', 500);
        }
      } else if (res.ok) {
        shown = null;
        UI.toast(AccountView.KEY_DELETED, 'ok');
      } else {
        // Whatever was on screen is not to be trusted after a refusal that got an answer (a create put the old key out first; a
        // refused delete may or may not have): the server's next answer says what exists.
        shown = null;
        notice = AccountView.errorMessage(action, res.status, (res.data || {}).code);
      }
      return Account.refresh().then(function () {
        // A refresh that got an answer drew the panel (and used up focusNext). When it didn't, show what the page already knew:
        // that draw is, for a new key, the only chance to see it, so it is not reconciled.
        if (focusNext !== null) render(Account.current());
      });
    });
  }

  // The key must not outlive the page: not in the back-forward cache, not on the way out.
  function scrub() {
    shown = null;
    var input = UI.byId('agent-key');
    if (input) input.value = '';
    render(Account.current()); // the panel and the command say what is true without the key
  }

  window.addEventListener('pagehide', scrub);
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    scrub();
    Account.refresh();
  });

  // An answer from the server settles which key exists: the one on screen stays only while the server has a key with that
  // creation time for a signed-in user (a sign-out takes the key with the session).
  function reconcile(me) {
    if (shown && me && (!me.user || !me.agentKey || me.agentKey.createdAt !== shown.createdAt)) shown = null;
  }

  Account.onChange(function (me) { reconcile(me); render(me); });
  Account.load().then(render);
})();
