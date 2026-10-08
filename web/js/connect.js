/*
 * Connect page: fills in the connector address and the Claude Code command from the page's own
 * origin, so the page is right on any host. Copy buttons are wired by ui.js through data-copy.
 *
 * With sign-in on it also shows the agent key panel (wording from account-view.js): a sign-in link when signed
 * out, else the list of the person's keys (each deleted on its own), an optional name for the next one, and create,
 * which shows the new key once. The key is only ever in the page for as long as it is on screen: it is
 * never written into markup (copyField sets it as a property, the command takes it as text), a reload loses it, and
 * so does leaving the page (pagehide) or coming back to it from the back-forward cache (pageshow).
 * With sign-in off there is no panel and the command has no key in it.
 * A signed-in person who has not been approved to use our AI also gets one line saying so, with a link to ask for it on the start page.
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

  var panelEl = UI.byId('agent-keys');
  var noteEl = UI.byId('command-note');
  var shown = null; // {key, kid} of the key just created, the only time it can be read
  var nameValue = ''; // what is typed in the name field, kept across a redraw
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
    // The sign-in link comes back through /key, which lands on this panel (the header's own link comes back to this page).
    var panel = AccountView.keyPanel(me, shown, '/key');
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
      ${panel.keys.length ? html`<ul class="list-reset stack stack--sm" id="key-list" aria-labelledby="key-title">${panel.keys.map(function (k) {
        return html`<li class="stack stack--sm" data-kid="${k.kid}">
          <strong>${k.label}</strong>
          <span class="text-caption">${k.created ? k.created + '. ' : ''}${k.lastUsed}</span>
          <div><button class="btn btn--link btn--flush" type="button" id="key-delete-${k.kid}" aria-label="${k.removeName}">${k.remove}</button></div>
        </li>`;
      })}</ul>` : false}
      ${notice ? UI.alertBox(notice, 'danger') : false}
      ${panel.signin ? html`<div><a class="btn btn--secondary" id="key-signin" href="${UI.url(panel.signin.href)}">${panel.signin.text}</a></div>` : false}
      ${panel.create ? html`<div class="field">
        <label class="field__label" for="key-name">${panel.nameField.label}</label>
        <input class="input" id="key-name" type="text" autocomplete="off">
      </div>
      <div class="cluster">
        <button class="btn btn--secondary" type="button" id="key-create">${panel.create}</button>
      </div>` : false}
    `);
    // The panel starts hidden, so the browser can't scroll to #agent-keys itself: do it when the panel first appears. It is
    // never hidden again (keyPanel is null only with sign-in off, and Account never forgets an answer), so this runs once.
    var appearing = panelEl.hidden;
    panelEl.hidden = false;
    if (appearing && location.hash === '#agent-keys') panelEl.scrollIntoView(); // only read: the key page never writes the address
    if (field) {
      field.fill(panelEl);
      UI.byId('agent-key').setAttribute('autocomplete', 'off'); // keep the key out of any form history
    }
    var create = UI.byId('key-create');
    var nameInput = UI.byId('key-name');
    if (nameInput) {
      nameInput.value = nameValue; // what was typed survives a redraw (a refused create, a deleted key)
      nameInput.addEventListener('input', function () { nameValue = nameInput.value; });
    }
    if (create) create.addEventListener('click', function () { act('keyCreate', create, makeKey, keyMade); });
    panel.keys.forEach(function (k) {
      var button = UI.byId('key-delete-' + k.kid);
      if (button) button.addEventListener('click', function () { act('keyRevoke', button, function () { return deleteKey(k.kid); }, function () { keyDeleted(k.kid, k.label); }); });
    });
    // Focus never falls to the page: the key field right after creating one, else the panel's own control.
    var want = focusNext;
    focusNext = null;
    var target = want === 'key' && field ? UI.byId('agent-key') : want ? create || UI.byId('key-signin') : null;
    if (target) target.focus();
  }

  function makeKey() {
    var name = nameValue.trim();
    return UI.request('POST', '/api/me/agent-key', { name: name }); // always sent: '' says none (the server refuses a body without it)
  }

  function deleteKey(kid) { return UI.request('POST', '/api/me/agent-key/revoke', { kid: kid }); }

  // A key was made: keep it on screen once, if the answer is a key.
  function keyMade(res) {
    var key = res.data && res.data.key;
    var newKid = res.data && res.data.kid;
    if (typeof key === 'string' && AccountView.KEY_PATTERN.test(key) && typeof newKid === 'string') {
      shown = { key: key, kid: newKid };
      nameValue = '';
      focusNext = 'key';
    } else {
      // A 201 with something else in it is not a key: say so rather than show it.
      notice = AccountView.errorMessage('keyCreate', 500);
    }
  }

  // A key was deleted. Deleting one key leaves the others, the one on screen included, unless it is the one deleted. The toast
  // names it by the label the panel gave it.
  function keyDeleted(kid, label) {
    if (shown && shown.kid === kid) shown = null;
    UI.toast(AccountView.keyDeleted(label), 'ok');
  }

  // One request at a time. Whatever answer comes back, the page asks the server again and shows that: a refusal can
  // still have changed things (a 401 means the session is gone, and a refused delete may have gone through in memory). Only
  // a network failure gets no answer, and then the page stays as it was.
  // onOk(res) runs when the server accepted it.
  function act(action, button, send, onOk) {
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
      if (res.ok) {
        onOk(res);
      } else {
        // A refusal changes nothing on screen: the server's next answer (a 401 means the session is gone) says what exists.
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

  // One line for a signed-in person without access to our AI (and only where the server has a built-in AI to ask for).
  var lineEl = UI.byId('ai-access-line');
  var hasBuiltin = false;

  function renderLine(me) {
    var line = hasBuiltin ? AccountView.connectLine(me) : null;
    UI.render(lineEl, line ? html`${line.text} <a href="${UI.url(line.href)}">${line.link}</a>` : html``);
    lineEl.hidden = !line;
  }

  window.addEventListener('pagehide', scrub);
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    scrub();
    Account.refresh();
  });

  // An answer from the server settles which keys exist: the one on screen stays only while the server still lists a key with
  // that kid for a signed-in user (a sign-out takes the keys with the session).
  function reconcile(me) {
    if (shown && me && (!me.user || !me.agentKeys.some(function (k) { return k.kid === shown.kid; }))) shown = null;
  }

  Account.onChange(function (me) { reconcile(me); render(me); renderLine(me); });
  Account.load().then(function (me) { render(me); renderLine(me); });
  UI.loadConfig().then(function (config) {
    hasBuiltin = Boolean(config && config.live);
    renderLine(Account.current());
  });
})();
