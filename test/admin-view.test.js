'use strict';
// web/js/admin-view.js: the admin page's wording and choices, pure. admin.js turns these into markup (the page itself is run in admin-page.test.js).
const { test } = require('node:test');
const assert = require('node:assert');

const { loadPure } = require('../test-support/source');
const { JARGON } = require('../test-support/copy');

const { mod: AdminView, assertClean } = loadPure('admin-view', { allowRequire: true });

const T0 = Date.UTC(2026, 9, 3, 12);
const T1 = Date.UTC(2026, 9, 5, 12);
const REQ = { userId: '1001', login: 'octocat', status: 'requested', note: 'I run a small shop.', requestedAt: T0, decidedAt: null };

// ---------- parseRequests ----------
test('parseRequests: reads the list into the six fields and nothing else', () => {
  const out = AdminView.parseRequests({ requests: [{ ...REQ, extra: 'x', email: 'a@b.test' }], more: 1 });
  assert.deepStrictEqual(out, [REQ]);
  assert.deepStrictEqual(AdminView.parseRequests({ requests: [] }), []);
});

test('parseRequests: anything that is not a list is null, so the page says it could not load', () => {
  for (const bad of [null, undefined, 'x', 7, [], {}, { requests: 'x' }, { requests: {} }, { requests: null }]) assert.strictEqual(AdminView.parseRequests(bad), null, JSON.stringify(bad));
});

test('parseRequests: an entry without a well-formed user id or a known status is left out; a user id given as a number is made text', () => {
  const ok = { ...REQ };
  const listed = (r) => AdminView.parseRequests({ requests: [r, ok] }).map((x) => x.userId);
  assert.deepStrictEqual(listed({ ...REQ, userId: 1002 }), ['1002', '1001']);
  for (const userId of ['', 'abc', '12 3', '1"x', '1234567890123456', -1, 1.5, null, undefined, {}, ['1'], '0x1', '１２']) assert.deepStrictEqual(listed({ ...REQ, userId }), ['1001'], String(userId));
  for (const status of ['GRANTED', 'admin', '', 7, null, undefined, '__proto__', 'constructor']) assert.deepStrictEqual(listed({ ...REQ, userId: '2', status }), ['1001'], String(status));
  for (const junk of [null, 'x', 7, [], undefined]) assert.deepStrictEqual(listed(junk), ['1001']);
});

test('parseRequests: a login or note that is not text is empty, text is trimmed, a time that is not a time is null', () => {
  const one = (over) => AdminView.parseRequests({ requests: [{ ...REQ, ...over }] })[0];
  assert.strictEqual(one({ login: 7 }).login, '');
  assert.strictEqual(one({ login: ' octocat ' }).login, 'octocat');
  for (const note of [7, {}, [], '', '   ', null, undefined]) assert.strictEqual(one({ note }).note, null, String(note));
  assert.strictEqual(one({ note: '  hi  ' }).note, 'hi');
  for (const v of ['5', NaN, Infinity, null, undefined, {}]) assert.deepStrictEqual([one({ requestedAt: v }).requestedAt, one({ decidedAt: v }).decidedAt], [null, null], String(v));
});

test('parseRequests: a note is returned as the text it is, hostile or not, and never altered into anything else', () => {
  const note = '<img src=x onerror=alert(1)> https://evil.test/x?a=1&b=2 javascript:alert(1)';
  assert.strictEqual(AdminView.parseRequests({ requests: [{ ...REQ, note }] })[0].note, note);
});

test('parseRequests: at most the number the server lists', () => {
  const many = Array.from({ length: AdminView.MAX_ROWS + 20 }, (_, i) => ({ ...REQ, userId: String(i + 1) }));
  assert.strictEqual(AdminView.parseRequests({ requests: many }).length, AdminView.MAX_ROWS);
  assert.strictEqual(AdminView.MAX_ROWS, 500);
});

test('USER_ID is the shape the server checks before it takes a decision: 1 to 15 digits', () => {
  assert.strictEqual(AdminView.USER_ID.source, '^[0-9]{1,15}$');
  assert.ok(AdminView.USER_ID.test('1') && AdminView.USER_ID.test('123456789012345'));
  for (const bad of ['', '1234567890123456', 'a', '1 ', ' 1', '-1', '1\n']) assert.ok(!AdminView.USER_ID.test(bad), JSON.stringify(bad));
});

// ---------- rows ----------
test('rows: login with @, the status as a word and a colour, when it was asked, the note apart from the buttons', () => {
  const [r] = AdminView.rows(AdminView.parseRequests({ requests: [REQ] }));
  assert.strictEqual(r.userId, '1001');
  assert.strictEqual(r.who, '@octocat');
  assert.deepStrictEqual(r.status, { label: 'Waiting', tone: 'warn' });
  assert.deepStrictEqual(r.dates, ['Asked 3 Oct 2026']);
  assert.strictEqual(r.note, 'I run a small shop.');
  assert.strictEqual(r.noteLabel, 'Their note');
});

test('rows: the buttons are the decisions that change something: grant and deny a waiting request, deny or reset a granted one, grant or reset a denied one', () => {
  const buttons = (status) => AdminView.rows([{ ...REQ, status }])[0].actions.map((a) => a.decision);
  assert.deepStrictEqual(buttons('requested'), ['grant', 'deny']);
  assert.deepStrictEqual(buttons('granted'), ['deny', 'reset']);
  assert.deepStrictEqual(buttons('denied'), ['grant', 'reset']);
  assert.deepStrictEqual(buttons('none'), ['grant', 'deny']);
  const [a] = AdminView.rows([REQ])[0].actions;
  assert.deepStrictEqual(a, { decision: 'grant', label: 'Grant', name: 'Grant @octocat' }, 'the name a screen reader hears says whose it is');
  assert.deepStrictEqual(AdminView.rows([REQ])[0].actions.map((x) => x.label), ['Grant', 'Deny']);
  assert.deepStrictEqual(AdminView.rows([{ ...REQ, status: 'granted' }])[0].actions.map((x) => x.label), ['Deny', 'Reset']);
});

test('rows: a decided request says when, a waiting one does not; no login reads "This person"; no note is null; no list is empty', () => {
  const r = AdminView.rows([{ ...REQ, status: 'granted', decidedAt: T1, note: null }])[0];
  assert.deepStrictEqual(r.dates, ['Asked 3 Oct 2026', 'Decided 5 Oct 2026']);
  assert.strictEqual(r.note, null);
  assert.deepStrictEqual(AdminView.rows([{ ...REQ, decidedAt: T1 }])[0].dates, ['Asked 3 Oct 2026'], 'a waiting request has no decision date');
  const bare = AdminView.rows([{ ...REQ, login: '', requestedAt: null }])[0];
  assert.deepStrictEqual([bare.who, bare.dates, bare.actions[0].name], ['This person', [], 'Grant This person']);
  assert.deepStrictEqual(AdminView.rows([]), []);
  assert.deepStrictEqual(AdminView.rows(null), []);
});

test('rows: each status has its own word and a tone the style guide has', () => {
  const tones = ['granted', 'requested', 'denied', 'none'].map((status) => AdminView.rows([{ ...REQ, status }])[0].status);
  assert.deepStrictEqual(tones.map((t) => t.label), ['Granted', 'Waiting', 'Denied', 'No request']);
  assert.deepStrictEqual(tones.map((t) => t.tone), ['ok', 'warn', 'danger', 'info']);
});

// ---------- states and sentences ----------
test('unavailable: a signed-in person is told it is not for their account, a signed-out one how to see it; both can go home', () => {
  const inn = AdminView.unavailable(true);
  const out = AdminView.unavailable(false);
  assert.strictEqual(inn.title, "This page isn't available.");
  assert.strictEqual(inn.lead, "It isn't available for your account.");
  assert.strictEqual(out.lead, 'Sign in with an administrator account to see it.');
  assert.deepStrictEqual([inn.home, inn.homeHref, out.homeHref], ['Go to the home page', '/', '/']);
  // with sign-in off there is no account to sign in with, whoever asks
  for (const signedIn of [true, false]) assert.strictEqual(AdminView.unavailable(signedIn, true).lead, 'This server has no admin page.');
  assert.strictEqual(AdminView.unavailable(false, false).lead, out.lead);
});

test('decided: a sentence for each decision, naming the person', () => {
  assert.strictEqual(AdminView.decided('grant', '@octocat'), '@octocat can now use our AI.');
  assert.strictEqual(AdminView.decided('deny', '@octocat'), '@octocat was denied.');
  assert.strictEqual(AdminView.decided('reset', '@octocat'), 'The request from @octocat was reset.');
});

test('errorMessage: a sentence by code for a refused decision, a 400 by status, the default for anything else, never the server text', () => {
  const NETWORK = "We couldn't reach the server. Check your connection and try again.";
  const def = AdminView.errorMessage('adminDecide', 500);
  assert.strictEqual(def, "We couldn't save that decision. Please try again.");
  assert.strictEqual(AdminView.errorMessage('adminDecide', 0, 'origin'), NETWORK, 'no connection beats a code');
  assert.strictEqual(AdminView.errorMessage('adminDecide', 403, 'origin'), 'Please reload the page and try again.');
  assert.strictEqual(AdminView.errorMessage('adminDecide', 415, 'content_type'), 'Something went wrong sending that. Reload the page and try again.');
  assert.match(AdminView.errorMessage('adminDecide', 503, 'saving_unavailable'), /nothing changed/);
  assert.match(AdminView.errorMessage('adminDecide', 400), /^That request no longer matches anyone\./);
  assert.strictEqual(AdminView.errorMessage('adminDecide', 400), AdminView.errorMessage('adminDecide', 400, 'unknown_code'), 'an unknown code is the status sentence');
  assert.strictEqual(AdminView.errorMessage('adminDecide', 418, 'unknown_code'), def);
  // a non-admin is answered 404 and never 401, so a 401 has no sentence of its own
  assert.strictEqual(AdminView.errorMessage('adminDecide', 401, 'signin_required'), def);
  for (const code of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'def', 'codes', 'statuses', '', undefined, null, 7, {}, ['origin'], 'ORIGIN']) assert.strictEqual(AdminView.errorMessage('adminDecide', 500, code), def, String(code));
  assert.strictEqual(AdminView.errorMessage('nope', 500, 'origin'), 'Something went wrong. Please try again.');
  assert.strictEqual(AdminView.errorMessage('__proto__', 500), 'Something went wrong. Please try again.');
  assert.strictEqual(AdminView.errorMessage('adminDecide', 'def'), def, '"def" is not a status');
  assert.strictEqual(AdminView.errorMessage.length, 3, '(action, status, code)');
});

test('every sentence a person reads on the admin page avoids protocol jargon and is a plain sentence', () => {
  const strings = [];
  const collect = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect); };
  collect([AdminView.TITLE, AdminView.LEAD, AdminView.LIST_TITLE, AdminView.EMPTY, AdminView.LOAD_FAILED, AdminView.RETRY, AdminView.LOADING]);
  collect([AdminView.unavailable(true), AdminView.unavailable(false), AdminView.unavailable(false, true)]);
  collect(['grant', 'deny', 'reset'].map((d) => AdminView.decided(d, '@a')));
  for (const status of ['granted', 'requested', 'denied', 'none']) collect(AdminView.rows([{ ...REQ, status, decidedAt: T1 }]));
  for (const code of ['origin', 'content_type', 'saving_unavailable']) collect(AdminView.errorMessage('adminDecide', 599, code));
  collect(AdminView.errorMessage('adminDecide', 400));
  assert.ok(strings.length > 25);
  for (const s of strings.filter((x) => !x.startsWith('/'))) assert.ok(!JARGON.test(s) && !/\btoken\b|api key|oauth|bearer/i.test(s), s);
});

test('admin-view is pure: no DOM, UI, markup or storage (it reads only account-view.js)', () => {
  assertClean();
});
