/*
 * Start a room, then invite the other person. DOM wiring only: link handling lives in links.js, and
 * every piece of dynamic markup goes through UI.html and UI.render.
 *
 * Wording: the form labels, field errors and invite steps are static on this page by design, because
 * nothing else reads them. The shared error sentences (RoomView.errorMessage), the invite email field's wording (RoomView.inviteEmailText,
 * inviteSending, inviteSent), the other person's name (RoomView.firstNameOf, which guards reserved names) and the step labels come from room-view.js.
 *
 * With sign-in on and nobody signed in, step 1 shows a sign-in link instead of the form (wording from account-view.js), whether
 * /api/me said so up front or a create came back 401. The form and that link both start hidden: one of them is shown once the
 * settings and /api/me have answered (or DECIDE_MS has passed, which shows the form), so the page never shows the form and
 * then swaps it. Pages require JS: if this script fails, both views stay hidden.
 * With sign-in on, a person who has not been approved to use our AI gets the "Our AI" card switched off and "My own AI" chosen, a
 * "Use our AI" block beside it (outside the card, which is one label) to ask for access, and a form that sends both seats as their own
 * AI (the server refuses a built-in seat for them). The block's wording is in account-view.js.
 * Step 1 posts the form to /api/rooms. Step 2 shows the other person's link, which the server never
 * returns again, so it is also kept in localStorage for a week (see links.js), and the creator's own link,
 * to come back to. Links older than that, or no longer valid, are swept out of localStorage on load.
 * With config.invite, step 2 also offers an optional email field that has the server email the other person's link (an extra:
 * copying the link works as before).
 * Once the room exists the form stays shut: a second submit would open a duplicate room.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var RoomView = window.RoomView;
  var AccountView = window.AccountView;
  var Account = window.Account;
  var Links = window.Links;
  var html = UI.html;

  // Drop stale invites first. Storage may be unavailable, and that never blocks the page.
  try { Links.sweep(localStorage, Date.now()); } catch (e) { /* storage unavailable */ }

  var LINKS_MESSAGE = "Your room was created, but its links didn't come back right. Please start a new room.";

  var form = UI.byId('start-form');
  var button = UI.byId('create-btn');
  var config = null;
  var submitting = false;
  var created = false; // the server made a room: the form never submits again
var limited = false; // signed in without access to our AI: both seats bring their own AI
var requesting = false; // an access request is out
var aiStatus = 'none'; // what the server says about this person's access to our AI
var BUILTIN_HINT = UI.byId('ai-builtin-hint').textContent; // the card's own words, back if access turns up
var OTHER_HINT = UI.byId('other-hint').textContent;

  // ---------- config ----------

  // The server's settings, applied to the form. Null when they couldn't be read (UI.loadConfig then tries
  // again on the next call).
  function loadConfig() {
    return UI.loadConfig().then(function (c) {
      if (!c) return null;
      config = c;
      applyConfig();
      return c;
    });
  }

  function applyConfig() {
    UI.byId('pass-field').hidden = !config.passcode;
    if (config.passcode) UI.byId('pass').setAttribute('aria-required', 'true');
    if (config.live) {
      UI.byId('other-hint').hidden = false;
      return;
    }
    // No built-in AI here: both seats bring their own agent, so the first card can't be chosen.
    var builtin = UI.byId('ai-builtin');
    builtin.disabled = true;
    UI.describedBy.add(builtin, 'ai-builtin-hint');
    UI.byId('ai-own').checked = true;
    UI.byId('ai-builtin-hint').textContent = "Not available here. This server has no built-in AI.";
    UI.byId('no-ai-note').hidden = false;
  }

  var configLoaded = loadConfig();

  // ---------- use our AI ----------

  var accessBox = UI.byId('ai-access');

  // The "Use our AI" block for the person's status. notice, if any, is a sentence about what just went wrong; kept is the note typed so far.
  function renderAccess(notice, kept) {
    var d = AccountView.aiAccess(aiStatus);
    UI.byId('ai-builtin-hint').textContent = d.hint;
    UI.render(accessBox, html`
      <h2 class="card__title">${d.title}</h2>
      <p class="text-muted" id="ai-access-lead" tabindex="-1">${d.lead}</p>
      ${d.note ? html`<div class="field">
        <label class="field__label" for="ai-note">${d.note.label}</label>
        <span class="field__hint" id="ai-note-hint">${d.note.hint}</span>
        <textarea class="textarea" id="ai-note" aria-describedby="ai-note-hint"></textarea>
      </div>` : false}
      <div id="ai-access-error">${notice ? UI.alertBox(notice, 'danger') : false}</div>
      ${d.button ? html`<div><button class="btn btn--secondary" type="button" id="ai-request">${d.button}</button></div>` : false}
    `);
    accessBox.hidden = false;
    if (d.button) {
      UI.byId('ai-note').value = kept || '';
      var request = UI.byId('ai-request');
      request.addEventListener('click', function () { requestAccess(request); });
    }
  }

  function requestAccess(request) {
    if (requesting) return;
    requesting = true;
    UI.setBusy(request, true);
    var note = UI.byId('ai-note').value.trim();
    UI.request('POST', '/api/me/ai-access', { note: note }).then(function (res) {
      requesting = false;
      if (res.ok) {
        // What the server holds now: requested, or already settled. A granted answer gives the person the card.
        applyAccess(Object.assign({}, Account.current(), { ai: AccountView.aiStatusOf(res.data) }));
        var lead = UI.byId('ai-access-lead');
        if (lead) lead.focus();
        return;
      }
      renderAccess(AccountView.errorMessage('aiRequest', res.status, (res.data || {}).code), note);
      UI.byId('ai-request').focus();
    });
  }

  // Applies what /api/me says about our AI to the form: without access (and with a built-in AI to ask for), the card is off,
  // "My own AI" is chosen and the block to ask for access shows; with access, the form is as it always was.
  function applyAccess(me) {
    if (config && config.live && AccountView.needsAiAccess(me)) {
      limited = true;
      aiStatus = me.ai;
      var builtin = UI.byId('ai-builtin');
      builtin.disabled = true;
      UI.byId('ai-own').checked = true;
      UI.describedBy.add(builtin, 'ai-access-lead');
      UI.byId('other-hint').textContent = AccountView.OWN_AI_HINT;
      renderAccess(null, '');
      return;
    }
    if (!limited) return;
    limited = false;
    var card = UI.byId('ai-builtin');
    card.disabled = false;
    UI.describedBy.remove(card, 'ai-access-lead');
    UI.byId('ai-builtin-hint').textContent = BUILTIN_HINT;
    UI.byId('other-hint').textContent = OTHER_HINT;
    UI.render(accessBox, html``);
    accessBox.hidden = true;
  }

  // The header's "Step n of 3"; no step (0) hides it.
  function showStep(n) {
    var label = UI.byId('step-label');
    if (n) label.textContent = RoomView.stepLabel(n);
    label.hidden = !n;
  }

  // ---------- sign in ----------

  var signinView = UI.byId('signin-view');

  // Sign-in is on and nobody is signed in: the form gives way to the one thing to do. notice, if any, is a
  // sentence about what just went wrong, shown above it.
  // With focus, the sign-in link takes the focus (the form it replaces had it).
  function showSignin(notice, focus) {
    var prompt = AccountView.startPrompt();
    UI.render(signinView, html`
      ${notice ? UI.alertBox(notice, 'danger') : false}
      <div class="card stack">
        <p>${prompt.lead}</p>
        <div class="cluster">
          <a class="btn btn--primary" id="signin-link" href="${UI.url(prompt.href)}">${UI.icon('github')}${prompt.button}</a>
          <a class="btn btn--link btn--flush" href="${UI.url(prompt.demoHref)}">${prompt.demo}</a>
        </div>
      </div>
    `);
    signinView.hidden = false;
    form.hidden = true;
    showStep(0); // "Step 1 of 3" means nothing when step 1 is signing in
    if (focus) UI.byId('signin-link').focus();
  }

  // The sign-in that failed sends people back here with ?signin=failed. Said once, then the address is tidied.
  var signinFailed = new URLSearchParams(location.search).get('signin') === 'failed';
  if (signinFailed) { try { history.replaceState(null, '', '/start'); } catch (e) { /* not fatal */ } }

  // Neither the form nor the sign-in shows until the page knows which one is wanted (both start hidden in start.html), so
  // nobody sees the form turn into the sign-in. Whether sign-in is on comes from the server's settings; /api/me is only
  // asked then, for the user (Account.load). Fails open: when either can't be read the form shows, and a refused create
  // brings the sign-in up instead.
  var DECIDE_MS = 2500; // a slow or silent answer must not leave the page empty: after this the form shows
  var decidedOnce = false;

  function decided(me) {
    if (decidedOnce) return; // the deadline and a late answer: whichever comes second changes nothing
    decidedOnce = true;
    UI.byId('start-view').removeAttribute('aria-busy');
    if (me && me.signin === 'github' && !me.user) {
      showSignin(signinFailed ? AccountView.SIGNIN_FAILED : null);
      return;
    }
    applyAccess(me);
    form.hidden = false;
    showStep(1);
    if (signinFailed) showError(AccountView.SIGNIN_FAILED);
  }

  // account.js started /api/me when it ran, in parallel with the settings (see there), so Account.load() here only joins that
  // question: the sign-in prompt waits for one round trip, and with sign-in off the form shows as soon as the settings say so.
  configLoaded.then(function (c) { return c && c.signin === 'github' ? Account.load() : null; }).then(decided, function () { decided(null); });
  setTimeout(function () { decided(null); }, DECIDE_MS);

  // ---------- validation ----------

  var FIELDS = [
    { id: 'topic', message: 'Tell us what you need to agree on.' },
    { id: 'you', message: 'Enter your name.' },
    { id: 'them', message: "Enter the other person's name." }
  ];

  // The passcode is only asked for when the server wants one.
  var PASS_FIELD = { id: 'pass', message: 'Enter the passcode.' };

  function activeFields() { return config && config.passcode ? FIELDS.concat(PASS_FIELD) : FIELDS; }

  function setFieldError(id, message) { UI.fieldError(UI.byId(id), UI.byId(id + '-error'), message); }

  // Shows every missing field's error and returns the first invalid input, or null.
  function validate() {
    var first = null;
    activeFields().forEach(function (f) {
      var input = UI.byId(f.id);
      var bad = input.value.trim() === '';
      setFieldError(f.id, bad ? f.message : '');
      if (bad && !first) first = input;
    });
    return first;
  }

  FIELDS.concat(PASS_FIELD).forEach(function (f) {
    UI.byId(f.id).addEventListener('input', function () {
      if (UI.byId(f.id).value.trim() !== '') setFieldError(f.id, '');
    });
  });

  // ---------- form error ----------

  function showError(message) { UI.render(UI.byId('form-error'), UI.alertBox(message, 'danger')); }

  function clearError() { UI.render(UI.byId('form-error'), html``); }

  // The button is disabled while the room is made, so focus is put back on it afterwards if it had it.
  var buttonHadFocus = false;

  function setBusy(busy) {
    if (busy) buttonHadFocus = document.activeElement === button;
    submitting = busy;
    UI.setBusy(button, busy);
    if (!busy && buttonHadFocus) button.focus();
  }

  // ---------- step 2: invite ----------

  // The creator's own link, rebased onto this origin, if it is the seat A link for this room. Else null.
  function ownRoomLink(room) {
    var link = Links.rebaseLink(room.links && room.links.A, location.origin);
    if (!link) return null;
    var u = new URL(link);
    return u.pathname === Links.roomPath(room.id) && u.searchParams.get('seat') === 'A' ? link : null;
  }

  // Once a room exists the form can't be used again, whatever happened to the invite step.
  function lockForm() { UI.disableAll(form); }

  // The invite by email. The address is echoed only on this page (through UI.html), and the server answers 202 before the
  // email is sent, so "sent" means handed over.
  var inviting = false;
  var sent = false; // one email per page view; the copy-link flow stays

  function wireEmail(roomId, token, text) {
    var input = UI.byId('invite-email');
    var send = UI.byId('invite-send');
    var status = UI.byId('invite-status');

    function say(safe) { UI.render(status, safe); }

    function sendInvite() {
      if (inviting || sent) return;
      var email = input.value.trim();
      if (email === '') {
        setFieldError('invite-email', text.empty);
        input.focus();
        return;
      }
      setFieldError('invite-email', '');
      inviting = true;
      UI.setBusy(send, true);
      say(html`<p class="text-muted">${RoomView.inviteSending(email)}</p>`);
      UI.request('POST', '/api/rooms/' + encodeURIComponent(roomId) + '/seats/A/invite', { token: token, email: email }).then(function (res) {
        inviting = false;
        UI.setBusy(send, false);
        if (res.ok) {
          sent = true;
          input.value = '';
          input.disabled = true;
          send.disabled = true;
          say(html`<p>${RoomView.inviteSent(email)}</p>`);
          return;
        }
        say(UI.alertBox(RoomView.errorMessage('invite', res.status, (res.data || {}).code), 'danger'));
      });
    }

    send.addEventListener('click', sendInvite);
    input.addEventListener('keydown', function (e) {
      if (e && e.key === 'Enter') { e.preventDefault(); sendInvite(); }
    });
  }

  // Returns false when the response's links can't be trusted, and shows nothing.
  function showInvite(room, nameA, nameB) {
    if (typeof room.id !== 'string') return false;
    // The invite is the one link that is saved, as a path only, so it must be a valid seat B link for this room.
    var entry = Links.inviteEntry({ roomId: room.id, link: room.links && room.links.B, now: Date.now() });
    var otherLink = entry ? Links.rebaseLink(room.links.B, location.origin) : null;
    var ownLink = ownRoomLink(room);
    if (!entry || !otherLink || !ownLink) return false;
    // The other person's first name as the room will show it (the reserved-name guard included).
    var otherName = RoomView.firstNameOf(nameA, nameB, 'B');

    // A full or failed save never blocks the page.
    try { localStorage.setItem(entry.key, entry.value); } catch (e) { /* storage unavailable */ }

    // The optional email is an extra on top of the link, only when the server can send it. Seat A's token is the one in
    // the creator's own link, which was just checked.
    var emailOn = Boolean(config && config.invite);
    var tokenA = Links.tokenOf(ownLink);
    var emailText = RoomView.inviteEmailText(otherName);
    var previewPath = Links.previewPath(room.id, 'B');
    var inviteField = UI.copyField({ id: 'invite-link', label: otherName + "'s link", note: "You can't get this link back later, so copy it now.", value: otherLink });
    var ownField = UI.copyField({ id: 'own-link', label: 'Your link', note: 'Keep this link to come back to your room. Anyone with it can act for you.', value: ownLink });
    UI.render(UI.byId('invite-view'), html`
      <div class="stack stack--sm">
        <h1 id="invite-title" tabindex="-1">Invite ${otherName}</h1>
        <p class="text-muted">Send ${otherName} this link however you normally talk: email, WhatsApp, Slack. It's their key to the room, so send it only to them.</p>
        ${limited ? html`<p class="text-muted">${AccountView.ownAiInvite(otherName)}</p>` : false}
      </div>

      <div class="card stack">
        ${inviteField.html}
        <p class="text-caption">Anyone with a link can act for that person. Send each link only to them.</p>
        <div><a class="btn btn--link" href="${UI.url(previewPath)}" target="_blank" rel="noopener noreferrer">Preview what ${otherName} will see</a></div>
      </div>

      ${emailOn ? html`<div class="card stack stack--sm">
        <div class="field">
          <label class="field__label" for="invite-email">${emailText.label}</label>
          <span class="field__hint" id="invite-email-hint">${emailText.hint}</span>
          <input class="input" id="invite-email" type="email" maxlength="254" autocomplete="email" aria-describedby="invite-email-hint">
          <span class="field__error" id="invite-email-error" hidden></span>
        </div>
        <div><button class="btn btn--secondary" type="button" id="invite-send">${emailText.send}</button></div>
        <div id="invite-status" role="status"></div>
      </div>` : false}

      <div class="card stack">
        ${ownField.html}
      </div>

      <div class="stack stack--sm">
        <h2>Next: tell your AI what you want</h2>
        <p class="text-muted">You can do this now, while you wait for ${otherName}. The AIs start talking once you've both finished.</p>
        <div><button class="btn btn--primary" type="button" id="continue-btn">Continue to your instructions</button></div>
      </div>
    `);
    // The links are never written into the markup: both are set as properties, and your own
    // link is only ever followed by the button handler (it carries your token).
    inviteField.fill(UI.byId('invite-view'));
    ownField.fill(UI.byId('invite-view'));
    UI.byId('continue-btn').addEventListener('click', function () { location.assign(UI.url(ownLink)); });
    if (emailOn) wireEmail(room.id, tokenA, emailText);

    UI.byId('start-view').hidden = true;
    UI.byId('invite-view').hidden = false;
    UI.byId('invite-footer').hidden = false;
    showStep(2);
    document.title = 'Invite ' + otherName + ' · Behalf';
    try { history.replaceState(null, '', '/start#invite'); } catch (e) { /* not fatal */ }
    UI.byId('invite-title').focus();
    window.scrollTo(0, 0);
    return true;
  }

  // ---------- submit ----------

  function createRoom(otherName) {
    var live = config.live && !limited; // without access to our AI both seats bring their own
    var body = {
      topic: UI.byId('topic').value.trim(),
      nameA: UI.byId('you').value.trim(),
      nameB: otherName,
      modeA: live && UI.byId('ai-builtin').checked ? 'builtin' : 'external',
      modeB: live ? 'builtin' : 'external',
      passcode: UI.byId('pass').value
    };
    return UI.request('POST', '/api/rooms', body);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (submitting || created) return;
    clearError();
    var invalid = validate();
    if (invalid) { invalid.focus(); return; }

    setBusy(true);
    var nameA = UI.byId('you').value.trim();
    var otherName = UI.byId('them').value.trim();
    configLoaded.then(function (c) { return c || loadConfig(); }).then(function (c) {
      if (!c) return { status: 0, ok: false };
      return createRoom(otherName);
    }).then(function (res) {
      setBusy(false);
      if (res.ok) {
        created = true;
        var shown = false;
        try { shown = showInvite(res.data, nameA, otherName); } catch (err) { shown = false; }
        if (shown) return;
        // The room exists, so the form stays shut. Put the form back in view if the invite got halfway.
        UI.byId('invite-view').hidden = true;
        UI.byId('invite-footer').hidden = true;
        UI.byId('start-view').hidden = false;
        showStep(1);
        lockForm();
        showError(LINKS_MESSAGE);
        return;
      }
      var code = (res.data || {}).code; // a refusal that says what it is carries a code
      // Not signed in (any more): the sign-in takes the form's place.
      if (res.status === 401 && code === 'signin_required') {
        showSignin(RoomView.errorMessage('create', 401, code), true);
        return;
      }
      // A refused passcode belongs on the passcode field, not in a banner. It has no code: a 403 with one (the
      // wrong origin) is not about the passcode.
      if (res.status === 403 && !code && config && config.passcode) {
        setFieldError('pass', RoomView.errorMessage('create', 403));
        UI.byId('pass').focus();
        return;
      }
      showError(RoomView.errorMessage('create', res.status, code));
      // Refused for want of access to our AI: ask again who this person is, so the form offers to ask for it.
      if (res.status === 403 && code === 'ai_access') Account.refresh().then(function (me) { if (me) applyAccess(me); });
    });
  });
})();
