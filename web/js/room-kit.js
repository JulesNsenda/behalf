/*
 * Room page kit: the markup helpers and the one seat-action flow the steps share, exported as A.ui, and
 * the step table A.steps with defineStep. It uses RoomApp (room-core.js), UI and RoomView, and holds no
 * step of its own.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var RV = window.RoomView;
  var html = UI.html;
  var A = window.RoomApp;

  function noop() {}

  A.steps = {};

  // A step is {view, wire, update, unmount}; the ones a step doesn't need do nothing.
  function defineStep(def) {
    return Object.assign({ wire: noop, update: noop, unmount: noop }, def);
  }

  function partyClass(seat) { return seat === 'A' ? 'party-a' : 'party-b'; }

  function callout(tone, text) { return UI.callout(tone, html`<p>${text}</p>`); }

  // Renders html into an element, or empties it, and keeps `hidden` in step so an empty slot adds no gap.
  function fill(el, safe) {
    if (!el) return;
    UI.render(el, safe || html``);
    el.hidden = !safe;
  }

  // Only for the failure of something the person just did: it is announced at once.
  function showError(slotId, message) {
    fill(UI.byId(slotId), UI.alertBox(message, 'danger'));
  }

  function focusTitle() {
    var h = UI.byId('step-title');
    if (h) h.focus();
  }

  function titleBlock(text) {
    return html`<h1 id="step-title" tabindex="-1">${text}</h1>`;
  }

  function topic() { return RV.str(A.room && A.room.topic); }

  // ---------- connect steps ----------

  function connectBlock(withPrompt) {
    var C = A.text.connect;
    var prompt = withPrompt ? html`<div class="stack stack--sm">
        <p class="field__label">${C.messageLabel}</p>
        <pre class="code-block" id="agent-prompt" tabindex="0"></pre>
        <div><button class="btn btn--secondary btn--small" type="button" data-copy="agent-prompt">${C.copyMessage}</button></div>
      </div>` : false;
    return html`<div class="card stack" id="connect-steps">
      <h2 class="card__title">${C.heading}</h2>
      <div class="stack stack--sm">
        <p class="field__label">${C.addressLabel}</p>
        <pre class="code-block" id="mcp-url" tabindex="0"></pre>
        <div><button class="btn btn--secondary btn--small" type="button" data-copy="mcp-url">${C.copyAddress}</button></div>
      </div>
      ${prompt}
      <div><a class="btn btn--link" href="/connect">${C.howTo}</a></div>
    </div>`;
  }

  // Values go in as text after render, never through the markup.
  function fillConnect(withPrompt) {
    var url = UI.byId('mcp-url');
    if (url) url.textContent = RV.mcpUrl(location.origin);
    var prompt = UI.byId('agent-prompt');
    if (prompt && withPrompt) prompt.textContent = RV.agentPrompt(A.promptLink());
  }

  // A lead-in callout and the connect steps, in a slot.
  function renderConnectSlot(slot, lead) {
    fill(slot, html`${lead}${connectBlock(true)}`);
    fillConnect(true);
  }

  // ---------- instructions card ----------

  function instructionsCard(seat) {
    var s = A.room.seats && A.room.seats[seat];
    var card = s && s.card;
    if (!card) return false;
    var sections = RV.INSTRUCTION_FIELDS.map(function (f) {
      var items = f.key === 'goal' ? [card.goal] : (Array.isArray(card[f.key]) ? card[f.key] : []);
      items = items.map(RV.str).filter(Boolean);
      if (!items.length) return false;
      return html`<div class="instructions__section">
        <h4 class="instructions__label">${f.label}</h4>
        <ul class="instructions__list">${items.map(function (x) { return html`<li>${x}</li>`; })}</ul>
      </div>`;
    });
    var badge = s.sealed ? html`<span class="pill pill--ok">${UI.icon('lock-sm')}${A.text.locked}</span>` : false;
    return html`<article class="instructions instructions--party ${partyClass(seat)}">
      <div class="instructions__head"><h3>${RV.instructionsHeading(A.room, seat)}</h3>${badge}</div>
      ${sections}
    </article>`;
  }

  // ---------- seat actions ----------

  // The flow every seat action shares: set the controls busy, clear the error slot, note what the action
  // expects, send, and either carry on or put everything back and say what went wrong.
  //   busy   the element or elements to set busy
  //   disable  optional element or elements to switch off while the action is out, without marking them busy.
  //          Only the ones that were enabled are switched off, and on failure only those are switched back on;
  //          the focus then returns to the first busy element, if it is still on the page and the focus was lost
  //          (on nothing, the page, the busy element or a switched-off one); focus the person moved elsewhere stays.
  //          On success they stay off when the refresh redrew the step (the first busy element has left the page),
  //          and are switched back on when it didn't (the first busy element is still there)
  //   error  the id of the error slot, which is cleared first and holds the failure message
  //   kind   the RoomView.errorMessage kind for a failure
  //   send   () -> a promise of {ok, status, data}
  //   focus  optional A.pendingFocus to set while the action is out, and drop again on failure
  //   ok     optional (res) -> whether it worked (default res.ok)
  //   done   optional (res) -> what to do on success (default A.refresh); returning false (or a promise of
  //          false) means the refresh got no new view: the controls are put back and the network message shown
  //   fail   optional () -> called after a failure, once the controls are back
  function act(o) {
    var busyEls = (Array.isArray(o.busy) ? o.busy : [o.busy]).filter(Boolean);
    // Only what act switches off itself is switched back on.
    var offEls = (Array.isArray(o.disable) ? o.disable : [o.disable]).filter(function (el) { return el && !el.disabled; });
    offEls.forEach(function (el) { el.disabled = true; });
    UI.setBusy(o.busy, true);
    fill(UI.byId(o.error), null);
    if (o.focus) A.pendingFocus = o.focus;
    // code is the machine code a refusal carries, if any: it picks a more exact sentence than the status does.
    function fail(status, code) {
      A.pendingFocus = null;
      UI.setBusy(o.busy, false);
      offEls.forEach(function (el) { el.disabled = false; });
      var first = busyEls[0];
      // A disabled control that had the focus drops it to the page, so the focus goes back only when it was lost.
      var active = document.activeElement;
      var lost = !active || active === document.body || active === first || offEls.indexOf(active) !== -1;
      if (lost && first && first.isConnected && typeof first.focus === 'function') first.focus();
      showError(o.error, RV.errorMessage(status === A.BLOCKED ? '' : o.kind, status, code));
      if (o.fail) o.fail();
    }
    return o.send().then(function (res) {
      if (!(o.ok ? o.ok(res) : res.ok)) { fail(res.status, (res.data || {}).code); return; }
      return Promise.resolve(o.done ? o.done(res) : A.refresh()).then(function (applied) {
        if (applied === false) { fail(0); return; }
        // The refresh redraws the step, which drops the switched-off controls. If the busy control is still on the
        // page nothing was redrawn, so they would stay dead: switch them back on, and the busy ones with them.
        var first = busyEls[0];
        if (first && first.isConnected) {
          UI.setBusy(o.busy, false);
          offEls.forEach(function (el) { el.disabled = false; });
        }
      });
    });
  }

  A.ui = {
    partyClass: partyClass,
    callout: callout,
    fill: fill,
    showError: showError,
    focusTitle: focusTitle,
    titleBlock: titleBlock,
    topic: topic,
    connectBlock: connectBlock,
    fillConnect: fillConnect,
    renderConnectSlot: renderConnectSlot,
    instructionsCard: instructionsCard,
    act: act,
    defineStep: defineStep
  };
})();
