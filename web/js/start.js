/*
 * Start a room, then invite the other person. DOM wiring only: link handling lives in links.js, and
 * every piece of dynamic markup goes through UI.html and UI.render.
 *
 * Wording: the form labels, field errors and invite steps are static on this page by design, because
 * nothing else reads them. Only the shared error sentences (RoomView.errorMessage) and the other
 * person's name (RoomView.firstNameOf, which guards reserved names) and the step labels come from room-view.js.
 *
 * With sign-in on and nobody signed in, step 1 shows a sign-in link instead of the form (wording from account-view.js), whether
 * /api/me said so up front or a create came back 401. The form and that link both start hidden: one of them is shown once the
 * settings and /api/me have answered (or DECIDE_MS has passed, which shows the form), so the page never shows the form and
 * then swaps it. Pages require JS: if this script fails, both views stay hidden.
 * Step 1 posts the form to /api/rooms. Step 2 shows the other person's link, which the server never
 * returns again, so it is also kept in localStorage for a week (see links.js), and the creator's own link,
 * to come back to. Links older than that, or no longer valid, are swept out of localStorage on load.
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
    UI.byId('step-label').hidden = true; // "Step 1 of 3" means nothing when step 1 is signing in
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
    form.hidden = false;
    UI.byId('step-label').hidden = false;
    if (signinFailed) showError(AccountView.SIGNIN_FAILED);
  }

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

    var previewPath = Links.previewPath(room.id, 'B');
    var inviteField = UI.copyField({ id: 'invite-link', label: otherName + "'s link", note: "You can't get this link back later, so copy it now.", value: otherLink });
    var ownField = UI.copyField({ id: 'own-link', label: 'Your link', note: 'Keep this link to come back to your room. Anyone with it can act for you.', value: ownLink });
    UI.render(UI.byId('invite-view'), html`
      <div class="stack stack--sm">
        <h1 id="invite-title" tabindex="-1">Invite ${otherName}</h1>
        <p class="text-muted">Send ${otherName} this link however you normally talk: email, WhatsApp, Slack. It's their key to the room, so send it only to them.</p>
      </div>

      <div class="card stack">
        ${inviteField.html}
        <p class="text-caption">Anyone with a link can act for that person. Send each link only to them.</p>
        <div><a class="btn btn--link" href="${UI.url(previewPath)}" target="_blank" rel="noopener noreferrer">Preview what ${otherName} will see</a></div>
      </div>

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

    UI.byId('start-view').hidden = true;
    UI.byId('invite-view').hidden = false;
    UI.byId('invite-footer').hidden = false;
    UI.byId('step-label').textContent = RoomView.stepLabel(2);
    UI.byId('step-label').hidden = false;
    document.title = 'Invite ' + otherName + ' · Behalf';
    try { history.replaceState(null, '', '/start#invite'); } catch (e) { /* not fatal */ }
    UI.byId('invite-title').focus();
    window.scrollTo(0, 0);
    return true;
  }

  // ---------- submit ----------

  function createRoom(otherName) {
    var live = config.live;
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
        UI.byId('step-label').textContent = RoomView.stepLabel(1);
        UI.byId('step-label').hidden = false;
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
    });
  });
})();
