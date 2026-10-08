/*
 * The admin page's wording and choices: pure functions that return plain data (strings and descriptors), no markup.
 *
 * Rules:
 *  - No DOM, no UI dependency. admin.js turns these results into markup through UI.html.
 *  - The server's answers are untrusted: parseRequests reads only the fields it knows and checks their types. A note is somebody else's
 *    text: it is returned as a string to be shown as text, never as a link.
 *  - The sentences for a refused decision are here (errorMessage); the page script holds no wording.
 *  - Dates come from account-view.js (formatDate), so the two pages read a time the same way.
 *
 * Plain language only: say "Our AI", "grant" and "request", never the machine words.
 */
(function () {
  'use strict';

  var has = Object.prototype.hasOwnProperty;
  var AV = typeof window !== 'undefined' ? window.AccountView : require('./account-view.js');

  var MAX_ROWS = 500; // the server lists at most this many (lib/ai-access.js)
  var USER_ID = /^[0-9]{1,15}$/; // a GitHub id, as the server checks it before a decision
  var STATUSES = ['granted', 'requested', 'denied', 'none'];

  var TITLE = 'Who can use our AI';
  var LEAD = 'People ask for access on the start page. Grant or deny each request here.';
  var LIST_TITLE = 'Requests';
  var EMPTY = 'No one has asked for access yet.';
  var NOTE_LABEL = 'Their note';
  var LOAD_FAILED = "We couldn't load the requests. Please try again.";
  var RETRY = 'Try again';
  var LOADING = 'Loading the requests.';

  var time = function (v) { return typeof v === 'number' && isFinite(v) ? v : null; };

  // The server's list as [{userId, login, status, note, requestedAt, decidedAt}], or null when the answer is not one. An entry without a
  // well-formed user id or a known status is left out; a login or note that is not text is empty.
  function parseRequests(data) {
    if (data === null || typeof data !== 'object' || !Array.isArray(data.requests)) return null;
    var out = [];
    data.requests.forEach(function (r) {
      if (out.length >= MAX_ROWS || r === null || typeof r !== 'object') return;
      var id = typeof r.userId === 'number' ? String(r.userId) : r.userId;
      if (typeof id !== 'string' || !USER_ID.test(id) || STATUSES.indexOf(r.status) === -1) return;
      out.push({
        userId: id,
        login: typeof r.login === 'string' ? r.login.trim() : '',
        status: r.status,
        note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : null,
        requestedAt: time(r.requestedAt),
        decidedAt: time(r.decidedAt)
      });
    });
    return out;
  }

  var STATUS = {
    granted: { label: 'Granted', tone: 'ok' },
    requested: { label: 'Waiting', tone: 'warn' },
    denied: { label: 'Denied', tone: 'danger' },
    none: { label: 'No request', tone: 'info' }
  };

  // The decisions that make sense for a status: not the state it is already in. Reset forgets the request.
  var DECISIONS = {
    granted: ['deny', 'reset'],
    requested: ['grant', 'deny'],
    denied: ['grant', 'reset'],
    none: ['grant', 'deny']
  };
  var VERB = { grant: 'Grant', deny: 'Deny', reset: 'Reset' };

  function who(login) { return login ? '@' + login : 'This person'; }

  // One row per request, in the server's order (waiting first):
  //   userId    for the decision's request
  //   who       "@login"
  //   status    {label, tone}: the word, and its colour (ok, warn, danger or info)
  //   dates     the lines about when, in order (asked, decided)
  //   note      the person's own words, or null; noteLabel says whose they are
  //   actions   [{decision, label, name}]: label is the button's word, name what a screen reader hears (it names the person)
  function rows(requests) {
    return (requests || []).map(function (r) {
      var asked = AV.formatDate(r.requestedAt);
      var decided = AV.formatDate(r.decidedAt);
      var dates = [];
      if (asked) dates.push('Asked ' + asked);
      if (decided && r.status !== 'requested') dates.push('Decided ' + decided);
      return {
        userId: r.userId,
        who: who(r.login),
        status: STATUS[r.status],
        dates: dates,
        note: r.note,
        noteLabel: NOTE_LABEL,
        actions: DECISIONS[r.status].map(function (d) {
          return { decision: d, label: VERB[d], name: VERB[d] + ' ' + who(r.login) };
        })
      };
    });
  }

  // What the page says when the list can't be shown to this person (the server answers 404 to anyone who is not an admin).
  // With sign-in off (signinOff) there are no accounts at all, so there is no one to sign in as.
  function unavailable(signedIn, signinOff) {
    return {
      title: "This page isn't available.",
      lead: signinOff ? 'This server has no admin page.'
        : signedIn ? "It isn't available for your account." : 'Sign in with an administrator account to see it.',
      home: 'Go to the home page',
      homeHref: '/'
    };
  }

  // The toast after a decision went through; name is the row's who.
  function decided(decision, name) {
    if (decision === 'grant') return name + ' can now use our AI.';
    if (decision === 'deny') return name + ' was denied.';
    return 'The request from ' + name + ' was reset.';
  }

  // ---------- refused decisions ----------
  var NETWORK = "We couldn't reach the server. Check your connection and try again.";
  var GENERIC = 'Something went wrong. Please try again.';
  var RELOAD = 'Please reload the page and try again.';
  var BAD_REQUEST = 'Something went wrong sending that. Reload the page and try again.';
  var ERRORS = {
    adminDecide: {
      def: "We couldn't save that decision. Please try again.",
      codes: {
        origin: RELOAD,
        content_type: BAD_REQUEST,
        // Nothing was changed: a decision is only done once it is saved.
        saving_unavailable: "We couldn't save that decision just now, so nothing changed. Try again in a minute."
      },
      // No code: a 400 is a request the server did not understand, such as a person who has gone since the list was loaded.
      statuses: { 400: 'That request no longer matches anyone. Reload the page to see the current list.' }
    }
  };

  // Fixed plain sentences, by the action, the HTTP status and the refusal's machine code. The code is untrusted and only ever picks among
  // the sentences here. Never takes or returns server text.
  function errorMessage(action, httpStatus, code) {
    if (httpStatus === 0) return NETWORK;
    if (typeof action !== 'string' || !has.call(ERRORS, action)) return GENERIC;
    var e = ERRORS[action];
    if (typeof code === 'string' && has.call(e.codes, code)) return e.codes[code];
    return has.call(e.statuses, httpStatus) ? e.statuses[httpStatus] : e.def;
  }

  var AdminView = {
    TITLE: TITLE,
    LEAD: LEAD,
    LIST_TITLE: LIST_TITLE,
    EMPTY: EMPTY,
    LOAD_FAILED: LOAD_FAILED,
    RETRY: RETRY,
    LOADING: LOADING,
    USER_ID: USER_ID,
    MAX_ROWS: MAX_ROWS,
    parseRequests: parseRequests,
    rows: rows,
    unavailable: unavailable,
    decided: decided,
    errorMessage: errorMessage
  };

  if (typeof window !== 'undefined') window.AdminView = AdminView;
  else if (typeof module !== 'undefined' && module.exports) module.exports = AdminView;
})();
