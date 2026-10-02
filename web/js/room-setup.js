/*
 * Room page setup steps: not found, spectator while drafting, welcome, instructions, ready and the demo
 * intro, registered in A.steps. They use RoomApp, A.ui (room-kit.js), UI and RoomView; the text is
 * RoomView's.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var RV = window.RoomView;
  var html = UI.html;
  var A = window.RoomApp;
  var ui = A.ui;

  // ---------- not found, spectator while drafting ----------

  A.steps['not-found'] = ui.defineStep({
    view: function () {
      return html`<div class="stack stack--md">
        ${ui.titleBlock(A.text.notFoundTitle)}
        <div class="cluster"><a class="btn btn--primary" href="/start">${A.text.startRoom}</a></div>
      </div>`;
    }
  });

  A.steps['spectator-drafting'] = ui.defineStep({
    view: function () {
      return html`<div class="stack stack--md">
        ${ui.titleBlock(ui.topic())}
        <p class="text-muted">${A.text.spectatorDrafting}</p>
      </div>`;
    }
  });

  // ---------- welcome and preview ----------

  A.steps.welcome = (function () {
    function whoChoice() {
      var text = A.text;
      return html`<fieldset class="stack stack--sm">
        <legend class="field__label">${text.whoLegend}</legend>
        <label class="radio-card">
          <input type="radio" name="who" value="builtin" id="who-builtin">
          <span class="radio-card__body"><span class="radio-card__title">${text.whoBuiltin.title}</span><span class="radio-card__hint">${text.whoBuiltin.hint}</span></span>
        </label>
        <label class="radio-card">
          <input type="radio" name="who" value="own" id="who-own">
          <span class="radio-card__body"><span class="radio-card__title">${text.whoOwn.title}</span><span class="radio-card__hint">${text.whoOwn.hint}</span><span class="radio-card__hint">${text.whoOwn.note}</span></span>
        </label>
      </fieldset>`;
    }

    function view() {
      var text = A.text;
      var room = A.room;
      return html`<div class="stack stack--md">
        <div class="stack stack--sm">
          <div><span class="pill pill--info">${text.invitation}</span></div>
          <h1 id="step-title" tabindex="-1">${text.welcomeTitle}</h1>
          <p class="text-muted">${text.welcomeIntro}</p>
        </div>
        <div class="stack stack--sm">${text.reassure.map(function (t) { return ui.callout('info', t); })}</div>
        ${room.live ? whoChoice() : false}
        ${ui.connectBlock(Boolean(room.seat))}
        <div class="cluster"><button class="btn btn--primary" type="button" id="welcome-continue"></button></div>
      </div>`;
    }

    function wire(step) {
      var live = Boolean(A.room.live);
      var preview = step.banner === 'preview';
      var own = UI.byId('who-own');
      var builtin = UI.byId('who-builtin');
      var box = UI.byId('connect-steps');
      var go = UI.byId('welcome-continue');
      ui.fillConnect(Boolean(A.room.seat));
      if (live) (A.ownChoice() ? own : builtin).checked = true;
      function sync() {
        var wantOwn = live && own.checked;
        box.hidden = live && !wantOwn;
        go.textContent = wantOwn ? A.text.continueOwnButton : A.text.continueButton;
      }
      sync();
      if (live) {
        [builtin, own].forEach(function (el) {
          el.addEventListener('change', function () {
            if (!preview) A.setOwnChoice(own.checked);
            sync();
          });
        });
      }
      go.addEventListener('click', function () {
        A.setFlag('welcome');
        A.pendingFocus = { steps: ['instructions'] };
        A.requestRender();
      });
      if (preview) UI.disableAll(UI.byId('app'));
    }

    return ui.defineStep({ view: view, wire: wire });
  })();

  // ---------- instructions ----------

  A.steps.instructions = (function () {
    // The form's state. Every input is always on the page, but `org` has no input: it travels with the
    // fields from a drafted or sealed card into the card that is locked.
    var fields = {};
    var sealing = false;
    var agentSig = null;
    var FIELD_IDS = ['name', 'role'].concat(RV.INSTRUCTION_FIELDS.map(function (f) { return f.key; }));

    // The draft lives in sessionStorage so a reload doesn't lose typing. Known risk: it is readable by
    // any script on this origin until the tab closes, so it is cleared once the instructions are locked
    // (A.sideEffects) and again on pagehide for a locked seat. Nothing else is stored.
    function saveDraft() {
      A.store.set(A.draftKey(), JSON.stringify({ fields: fields, help: UI.byId('help-text') ? UI.byId('help-text').value : '' }));
    }

    function loadDraft() {
      var raw = A.store.get(A.draftKey());
      if (!raw) return null;
      try {
        var v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
      } catch (e) { return null; }
    }

    function principalBase() {
      var s = A.mine();
      if (s && s.card && s.card.principal) return s.card.principal;
      return { name: RV.givenName(s), role: (s && s.role) || '' };
    }

    function initialFields(saved) {
      var s = A.mine();
      var base = RV.fieldsFromCard(s && s.card);
      if (!base.name) base.name = RV.givenName(s);
      return saved && saved.fields && typeof saved.fields === 'object' ? Object.assign(base, saved.fields) : base;
    }

    function fieldBlock(f) {
      var text = A.text;
      var id = 'f-' + f.key;
      var hint = f.hint ? html`<span class="field__hint" id="${id}-hint">${f.hint}</span>` : false;
      var opt = f.required ? false : html` <span class="text-caption">${text.optional}</span>`;
      var control = f.list
        ? html`<textarea class="textarea" id="${id}"></textarea>`
        : html`<input class="input" id="${id}" type="text" autocomplete="off">`;
      return html`<div class="field" id="${id}-field">
        <label class="field__label" for="${id}">${f.label}${opt}</label>
        ${hint}
        ${control}
        <span class="field__error" id="${id}-error" hidden></span>
      </div>`;
    }

    function helpBlock() {
      var help = A.text.help;
      return html`<details class="disclosure" id="help-box">
        <summary>${help.summary}</summary>
        <div class="disclosure__body stack stack--sm">
          <div class="field">
            <label class="field__label" for="help-text">${help.label}</label>
            <span class="field__hint" id="help-hint">${help.hint}</span>
            <textarea class="textarea" id="help-text" aria-describedby="help-hint"></textarea>
          </div>
          <div id="help-confirm" hidden></div>
          <div class="cluster"><button class="btn btn--secondary" type="button" id="help-go">${help.go}</button></div>
          <div id="help-error" hidden></div>
        </div>
      </details>`;
    }

    function view() {
      var text = A.text;
      return html`<div class="stack stack--md">
        <div class="stack stack--sm">
          ${ui.titleBlock(text.instructionsTitle)}
          <p class="text-muted">${text.instructionsIntro}</p>
        </div>
        <div id="agent-slot" class="stack stack--md" hidden></div>
        ${A.room.live && !A.room.demo ? helpBlock() : false}
        <form class="stack stack--md" id="instructions-form" novalidate>
          <div class="grid-auto">
            ${fieldBlock({ key: 'name', label: text.nameLabel, required: true })}
            ${fieldBlock({ key: 'role', label: text.roleLabel, required: false })}
          </div>
          ${RV.INSTRUCTION_FIELDS.map(fieldBlock)}
          ${UI.callout('info', html`<p>${text.lockNote}</p>`, { icon: 'lock' })}
          <div id="seal-error" hidden></div>
          <div class="cluster"><button class="btn btn--primary" type="submit" id="seal-btn">${text.lockButton}</button></div>
        </form>
      </div>`;
    }

    function fieldEl(key) { return UI.byId('f-' + key); }

    function writeFields() {
      FIELD_IDS.forEach(function (k) {
        var el = fieldEl(k);
        if (el) el.value = fields[k] || '';
      });
    }

    function readFields() {
      var out = Object.assign({}, fields);
      FIELD_IDS.forEach(function (k) {
        var el = fieldEl(k);
        if (el) out[k] = el.value;
      });
      return out;
    }

    function setFieldError(key, message) {
      var el = fieldEl(key);
      var err = UI.byId('f-' + key + '-error');
      if (el && err) UI.fieldError(el, err, message);
    }

    function anyText() {
      var f = readFields();
      return RV.INSTRUCTION_FIELDS.some(function (d) { return String(f[d.key] || '').trim() !== ''; });
    }

    function seal() {
      if (sealing) return;
      var f = readFields();
      var errors = RV.validateFields(f);
      if (!String(f.name || '').trim()) errors.name = A.text.nameError;
      FIELD_IDS.forEach(function (k) { setFieldError(k, errors[k] || ''); });
      var firstBad = FIELD_IDS.filter(function (k) { return errors[k]; })[0];
      if (firstBad) { fieldEl(firstBad).focus(); return; }

      sealing = true;
      ui.act({
        busy: UI.byId('seal-btn'),
        error: 'seal-error',
        kind: 'seal',
        focus: { steps: ['ready', 'conversation'] },
        send: function () { return A.post(A.room.seat, 'seal', { card: RV.cardFromFields(f, principalBase()) }); },
        done: function () { A.clearDraft(); return A.refresh(); }
      }).then(function () { sealing = false; });
    }

    // ---- help drafting ----

    function helpFail(status) { ui.showError('help-error', RV.errorMessage('draft', status)); }

    function draftFromHelp() {
      var f = readFields();
      var asked = UI.byId('help-text').value.trim();
      if (!String(f.name || '').trim() || !asked) { helpFail(400); return; }
      var go = UI.byId('help-go');
      ui.act({
        busy: go,
        error: 'help-error',
        kind: 'draft',
        send: function () { return A.post(A.room.seat, 'draft', { name: f.name.trim(), role: String(f.role || '').trim(), text: asked }); },
        done: function (res) {
          UI.setBusy(go, false);
          var drafted = RV.fieldsFromCard(res.data && res.data.card);
          var typed = readFields();
          fields = Object.assign({}, typed, drafted, { name: typed.name, role: drafted.role || typed.role });
          writeFields();
          saveDraft();
          UI.toast(A.text.help.added, 'ok');
          fieldEl('goal').focus();
        }
      });
    }

    function closeConfirm() { ui.fill(UI.byId('help-confirm'), null); }

    // Asks before drafting over text the person has already written.
    function askReplace() {
      var help = A.text.help;
      ui.fill(UI.byId('help-confirm'), UI.callout('warn', html`<p>${help.confirm}</p>
        <div class="cluster">
          <button class="btn btn--secondary btn--small" type="button" id="help-replace">${help.replace}</button>
          <button class="btn btn--secondary btn--small" type="button" id="help-keep">${help.keep}</button>
        </div>`));
      UI.byId('help-replace').addEventListener('click', function () { closeConfirm(); draftFromHelp(); });
      UI.byId('help-keep').addEventListener('click', function () { closeConfirm(); UI.byId('help-go').focus(); });
      UI.byId('help-replace').focus();
    }

    function wireHelp(saved) {
      var s = A.mine();
      UI.byId('help-text').value = (saved && typeof saved.help === 'string' && saved.help) || (s && typeof s.draftText === 'string' ? s.draftText : '');
      UI.byId('help-go').addEventListener('click', function () {
        if (anyText()) askReplace(); else draftFromHelp();
      });
      UI.byId('help-text').addEventListener('input', saveDraft);
    }

    function wire() {
      sealing = false;
      agentSig = null;
      var saved = loadDraft();
      fields = initialFields(saved);
      writeFields();
      RV.INSTRUCTION_FIELDS.forEach(function (f) {
        var el = fieldEl(f.key);
        if (f.hint) el.setAttribute('aria-describedby', 'f-' + f.key + '-hint');
        if (f.required) el.setAttribute('aria-required', 'true');
      });
      fieldEl('name').setAttribute('aria-required', 'true');

      var form = UI.byId('instructions-form');
      form.addEventListener('input', function (e) {
        fields = readFields();
        saveDraft();
        var id = e.target && e.target.id ? e.target.id.slice(2) : '';
        if (FIELD_IDS.indexOf(id) !== -1 && e.target.value.trim() !== '') setFieldError(id, '');
      });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        seal();
      });
      if (UI.byId('help-go')) wireHelp(saved);
    }

    // The agent callout and connect steps follow the seat's mode and the choice made on the welcome step,
    // without touching the form.
    function update() {
      var s = A.mine();
      var mode = s && s.mode;
      var connected = Boolean(s && s.agent);
      var own = A.ownChoice();
      var sig = JSON.stringify([mode, connected, own]);
      if (sig === agentSig) return;
      agentSig = sig;
      var slot = UI.byId('agent-slot');
      if (mode !== 'external' && !own) ui.fill(slot, null);
      else if (connected) ui.fill(slot, ui.callout('info', A.text.agentConnected));
      else ui.renderConnectSlot(slot, mode === 'external' ? ui.callout('info', A.text.externalCallout) : ui.callout('warn', A.text.connectFirst));
    }

    return ui.defineStep({ view: view, wire: wire, update: update });
  })();

  // ---------- ready ----------

  A.steps.ready = (function () {
    var shown = null;

    function view() {
      var text = A.text;
      return html`<div class="stack stack--md">
        <div class="stack stack--sm">
          ${ui.titleBlock(text.readyTitle)}
          <p>${text.readyWaiting}</p>
          <p class="text-muted">${text.readyComeBack}</p>
        </div>
        <div id="invite-slot" hidden></div>
      </div>`;
    }

    function update() {
      if (shown === A.inviteLink) return;
      shown = A.inviteLink;
      var slot = UI.byId('invite-slot');
      if (!shown) { ui.fill(slot, null); return; }
      var text = A.text;
      var field = UI.copyField({ id: 'invite-link', label: text.inviteLabel, note: text.inviteHint, value: shown, button: text.copyLink });
      ui.fill(slot, html`<div class="card stack">${field.html}</div>`);
      field.fill(slot);
    }

    return ui.defineStep({ view: view, wire: function () { shown = null; }, update: update });
  })();

  // ---------- demo intro ----------

  A.steps['demo-intro'] = ui.defineStep({
    view: function () {
      var text = A.text;
      return html`<div class="stack stack--md">
        ${ui.callout('info', text.demoBanner)}
        ${ui.titleBlock(ui.topic())}
        <details class="disclosure">
          <summary>${text.demoInstructions}</summary>
          <div class="disclosure__body stack stack--sm">${ui.instructionsCard('A')}${ui.instructionsCard('B')}</div>
        </details>
        <div id="demo-error" hidden></div>
        <div class="cluster"><button class="btn btn--primary" type="button" id="demo-start">${text.demoStart}</button></div>
      </div>`;
    },
    wire: function () {
      var btn = UI.byId('demo-start');
      btn.addEventListener('click', function () {
        ui.act({
          busy: btn,
          error: 'demo-error',
          kind: 'seal',
          focus: { steps: ['conversation'] },
          // One person plays both sides, so both seals go through the one shared token.
          send: function () {
            return A.post('A', 'seal', {}).then(function (a) {
              if (!a.ok && a.status !== 409) return a;
              return A.post('B', 'seal', {});
            });
          },
          ok: function (res) { return res.ok || res.status === 409; },
          done: function () { A.setFlag('demo'); return A.refresh(); }
        });
      });
    }
  });
})();
