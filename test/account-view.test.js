'use strict';
// web/js/account-view.js: the sign-in wording and choices, pure. Pages turn these into markup (account.js, start.js, connect.js).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { loadPure } = require('../test-support/source');
const { JARGON } = require('../test-support/copy');
const { createAuth } = require('../lib/auth');
const { createStore } = require('../lib/store');
const { loadConfig, loadSecrets } = require('../lib/config');
const { mkTmp, rmTmp } = require('../test-support/server');
const { quietLog } = require('../test-support/app');

const { mod: AV, assertClean } = loadPure('account-view');
const { mod: RV } = loadPure('room-view');
const { UI_DIR } = require('../test-support/paths');
const fs = require('node:fs');

const ME_OFF = { signin: 'off', user: null, agentKey: null };
const ME_OUT = { signin: 'github', user: null, agentKey: null };
const ME_IN = { signin: 'github', user: { login: 'octocat' }, agentKey: null };
const ME_KEY = { signin: 'github', user: { login: 'octocat' }, agentKey: { createdAt: Date.UTC(2026, 9, 3, 23, 59, 59) } };
const NEW_KEY = { key: 'bh_THE-SECRET-KEY-VALUE', createdAt: 1 };

// ---------- signinHref ----------
test('signinHref: the page the person is on comes back after sign-in when it is one of the allowed pages, else no next', () => {
  assert.strictEqual(AV.signinHref('/'), '/auth/github?next=/');
  assert.strictEqual(AV.signinHref('/start'), '/auth/github?next=/start');
  assert.strictEqual(AV.signinHref('/connect'), '/auth/github?next=/connect');
  for (const p of ['/spec', '/room/abc', '/start/', '/connect?x=1', '', undefined, null, 7, '//evil.test', 'https://evil.test', '/\\evil.test', '/ui/']) {
    assert.strictEqual(AV.signinHref(p), '/auth/github', String(p));
  }
});

test('signinHref and the server agree on which pages a sign-in can return to', (t) => {
  const dir = mkTmp('account-view-');
  const store = createStore({ file: path.join(dir, 'rooms.json'), log: quietLog() });
  store.load();
  t.after(async () => { await store.close(); rmTmp(dir); });
  const auth = createAuth({
    store, canRevoke: () => true, log: quietLog(), fetch: async () => { throw new Error('no network'); },
    config: loadConfig({ SIGNIN: 'github', PUBLIC_URL: 'https://behalf.test' }),
    secrets: loadSecrets({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }),
  });
  const pages = ['/', '/start', '/connect', '/spec', '/brief/x', '/room/x', '/ui/', '/start/', '/connect/', '/index.html'];
  for (const p of pages) {
    const href = AV.signinHref(p);
    const next = new URL(href, 'https://behalf.test').searchParams.get('next');
    assert.strictEqual(auth.beginLogin(next).next, AV.SIGNIN_NEXT.includes(p) ? p : '/', p);
    assert.strictEqual(auth.beginLogin(p).next === p, AV.SIGNIN_NEXT.includes(p), `the server's own list, for ${p}`);
  }
  assert.deepStrictEqual([...AV.SIGNIN_NEXT].sort(), ['/', '/connect', '/start']);
});

// ---------- parseMe ----------
test('parseMe: reads /api/me into the three fields and nothing else', () => {
  assert.deepStrictEqual(AV.parseMe({ user: null, signin: 'off', agentKey: null }), ME_OFF);
  assert.deepStrictEqual(AV.parseMe({ user: null, signin: 'github', agentKey: null }), ME_OUT);
  assert.deepStrictEqual(AV.parseMe({ user: { login: 'octocat', id: '1001', email: 'x' }, signin: 'github', agentKey: null, extra: 1 }), ME_IN);
  assert.deepStrictEqual(AV.parseMe({ user: { login: ' octocat ' }, signin: 'github', agentKey: { createdAt: 5, key: 'leak' } }), { signin: 'github', user: { login: 'octocat' }, agentKey: { createdAt: 5 } });
});

test('parseMe: anything that is not that shape is null, and a key without a user is dropped', () => {
  for (const bad of [null, undefined, 'x', 7, [], {}, { signin: 'on' }, { signin: 'GitHub' }, { signin: ['github'] }, { user: null }]) assert.strictEqual(AV.parseMe(bad), null, JSON.stringify(bad));
  assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: null, agentKey: { createdAt: 5 } }).agentKey, null, 'a key with no user is not a key');
  assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: { login: 7 } }).user, { login: '' }, 'a login that is not text is empty');
  assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: {} }).user, { login: '' });
  for (const createdAt of ['5', NaN, Infinity, null, undefined, {}]) assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: { login: 'a' }, agentKey: { createdAt } }).agentKey, { createdAt: null }, String(createdAt));
  assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: { login: 'a' }, agentKey: 'yes' }).agentKey, null);
});

// ---------- header slot ----------
test('slot: empty with sign-in off or unreadable, a sign-in link when signed out, who and Sign out when signed in', () => {
  assert.strictEqual(AV.slot(ME_OFF, '/'), null);
  assert.strictEqual(AV.slot(null, '/'), null);
  assert.strictEqual(AV.slot(undefined, '/connect'), null);
  assert.deepStrictEqual(AV.slot(ME_OUT, '/connect'), { kind: 'signed-out', text: 'Sign in with GitHub', short: 'Sign in', href: '/auth/github?next=/connect' });
  assert.deepStrictEqual(AV.slot(ME_OUT, '/'), { kind: 'signed-out', text: 'Sign in with GitHub', short: 'Sign in', href: '/auth/github?next=/' });
  assert.deepStrictEqual(AV.slot(ME_OUT, '/spec'), { kind: 'signed-out', text: 'Sign in with GitHub', short: 'Sign in', href: '/auth/github' }, 'a page it cannot come back to signs in and lands on the home page');
  assert.deepStrictEqual(AV.slot(ME_IN, '/spec'), { kind: 'signed-in', who: 'octocat', hint: 'Signed in as ', signOut: 'Sign out' });
  assert.deepStrictEqual(AV.slot(ME_KEY, '/'), { kind: 'signed-in', who: 'octocat', hint: 'Signed in as ', signOut: 'Sign out' });
  assert.deepStrictEqual(AV.slot({ signin: 'github', user: { login: '' }, agentKey: null }, '/'), { kind: 'signed-in', who: 'Signed in', hint: '', signOut: 'Sign out' });
});

// ---------- start page ----------
test('startPrompt: one plain sentence, one sign-in link that comes back to /start, and a way to watch the demo instead', () => {
  const p = AV.startPrompt();
  assert.strictEqual(p.href, '/auth/github?next=/start');
  assert.strictEqual(p.button, 'Sign in with GitHub');
  assert.match(p.lead, /^Sign in with GitHub to open a room\./);
  assert.strictEqual(p.demoHref, '/#demo');
  assert.strictEqual(p.demo, 'Watch the demo instead');
  assert.strictEqual(AV.SIGNIN_FAILED, "Sign-in didn't work. Please try again.");
});

// ---------- dates ----------
test('formatDate: day, month and year in UTC, so every machine reads the same time the same way', () => {
  assert.strictEqual(AV.formatDate(Date.UTC(2026, 9, 3, 23, 59, 59)), '3 Oct 2026');
  assert.strictEqual(AV.formatDate(Date.UTC(2026, 0, 1, 0, 0, 0)), '1 Jan 2026');
  assert.strictEqual(AV.formatDate(Date.UTC(2027, 11, 31, 12)), '31 Dec 2027');
  for (const m of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) assert.match(AV.formatDate(Date.UTC(2026, m, 15)), /^15 (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) 2026$/);
  for (const bad of [undefined, null, '1700000000000', NaN, Infinity, {}, 8.64e15 + 1]) assert.strictEqual(AV.formatDate(bad), null, String(bad));
});

// ---------- the agent key panel ----------
test('keyPanel: no panel with sign-in off or an unreadable answer', () => {
  assert.strictEqual(AV.keyPanel(ME_OFF, null, '/connect'), null);
  assert.strictEqual(AV.keyPanel(null, null, '/connect'), null);
  assert.strictEqual(AV.keyPanel(ME_OFF, NEW_KEY, '/connect'), null, 'a key held from before does not make a panel');
});

test('keyPanel: signed out is a sign-in link and nothing to make or revoke, whatever key was held', () => {
  for (const held of [null, NEW_KEY]) {
    const p = AV.keyPanel(ME_OUT, held, '/connect');
    assert.strictEqual(p.state, 'signed-out');
    assert.deepStrictEqual(p.signin, { text: 'Sign in with GitHub', href: '/auth/github?next=/connect' });
    assert.deepStrictEqual([p.create, p.revoke, p.field, p.warning, p.commandNote], [null, null, null, null, null]);
    assert.match(p.lead, /sign in first/);
    assert.ok(!JSON.stringify(p).includes(NEW_KEY.key));
  }
});

test('keyPanel: signed in with no key offers to make one, and explains what an agent key is once', () => {
  const p = AV.keyPanel(ME_IN, null, '/connect');
  assert.strictEqual(p.state, 'no-key');
  assert.strictEqual(p.title, 'Your agent key');
  assert.strictEqual(p.create, 'Create an agent key');
  assert.strictEqual(p.revoke, null);
  assert.strictEqual(p.signin, null);
  assert.match(p.lead, /^An agent key is a secret code that lets your own AI agent open rooms for you\./);
  assert.strictEqual(p.commandNote, null, 'the command has no header when there is no key');
  assert.strictEqual(p.commandKey, null);
});

test('keyPanel: a key that exists says when it was made and that it cannot be shown again, and offers a new one or revoking it', () => {
  const p = AV.keyPanel(ME_KEY, null, '/connect');
  assert.strictEqual(p.state, 'has-key');
  assert.match(p.lead, /^You created an agent key on 3 Oct 2026\. We can't show it again\./);
  assert.strictEqual(p.create, 'Create a new key');
  assert.strictEqual(p.revoke, 'Delete key');
  assert.strictEqual(p.field, null);
  assert.strictEqual(p.commandNote, 'In this command, replace YOUR_AGENT_KEY with your key.');
  assert.strictEqual(p.commandKey, 'YOUR_AGENT_KEY', 'the command carries the word the note names');
  const undated = AV.keyPanel({ ...ME_KEY, agentKey: { createdAt: null } }, null, '/connect');
  assert.match(undated.lead, /^You have an agent key\. We can't show it again\./);
});

test('keyPanel: the new key is shown once, in a copy field with a warning, and is never part of what this module returns', () => {
  const p = AV.keyPanel(ME_IN, NEW_KEY, '/connect');
  assert.strictEqual(p.state, 'new-key');
  assert.deepStrictEqual(p.field, { label: 'Your key', note: "Anyone with this key can open rooms as you. It is saved in your app's settings and your command history, so treat it like a password.", button: 'Copy key' });
  assert.strictEqual(p.lead, 'Your new key is below, and the command in step 1 now includes it.');
  assert.strictEqual(p.warning, "Copy it now. We can't show it again.");
  assert.strictEqual(p.create, 'Create a new key');
  assert.strictEqual(p.revoke, 'Delete key');
  assert.match(p.commandNote, /has your new agent key in it/);
  assert.strictEqual(p.commandKey, NEW_KEY.key, 'the command carries the new key');
  assert.ok(!JSON.stringify({ ...p, commandKey: null }).includes(NEW_KEY.key), 'the key is nowhere else: the page sets the field from its own copy');
  // the same wins over an existing record: the key just made is what the page shows
  assert.strictEqual(AV.keyPanel(ME_KEY, NEW_KEY, '/connect').state, 'new-key');
  // a held key that is empty or not text is not a key
  for (const held of [{ key: '' }, { key: 7 }, {}, { createdAt: 1 }]) assert.strictEqual(AV.keyPanel(ME_IN, held, '/connect').state, 'no-key', JSON.stringify(held));
  assert.strictEqual(AV.keyPanel(ME_KEY, { key: '' }, '/connect').state, 'has-key');
});

test('every sentence a person reads here avoids protocol jargon, and says "agent key", not "token" or "API key"', () => {
  const strings = [];
  const collect = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect); };
  for (const me of [ME_OUT, ME_IN, ME_KEY]) for (const held of [null, NEW_KEY]) { collect(AV.keyPanel(me, held, '/connect')); collect(AV.slot(me, '/')); }
  collect(AV.startPrompt());
  collect([AV.SIGNIN_FAILED, AV.KEY_DELETED, AV.SIGNED_OUT]);
  assert.ok(strings.length > 30);
  for (const s of strings.filter((x) => !x.startsWith('/'))) {
    assert.ok(!JARGON.test(s), s);
    assert.ok(!/\btoken\b|api key|oauth|bearer(?! with)/i.test(s), s);
  }
});

// ---------- refused requests ----------
const ACTIONS = ['logout', 'keyCreate', 'keyRevoke'];

test('errorMessage: a sentence by code for each sign-out and agent key action, the action default for anything else', () => {
  const NETWORK = "We couldn't reach the server. Check your connection and try again.";
  for (const a of ACTIONS) {
    const def = AV.errorMessage(a, 500);
    assert.ok(/[.]$/.test(def), a);
    assert.strictEqual(AV.errorMessage(a, undefined), def);
    assert.strictEqual(AV.errorMessage(a, 418, 'unknown_code'), def);
    assert.strictEqual(AV.errorMessage(a, 0, 'origin'), NETWORK, 'no connection beats a code');
    assert.strictEqual(AV.errorMessage(a, 0), RV.errorMessage('seal', 0), 'the same sentence as every other page');
    for (const code of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'def', 'codes', '', undefined, null, 7, {}, ['origin'], 'ORIGIN']) assert.strictEqual(AV.errorMessage(a, 500, code), def, `${a} ${String(code)}`);
  }
  assert.strictEqual(AV.errorMessage('nope', 500, 'origin'), 'Something went wrong. Please try again.');
  assert.strictEqual(AV.errorMessage('__proto__', 500), 'Something went wrong. Please try again.');
  assert.strictEqual(AV.errorMessage.length, 3);
  assert.strictEqual(AV.errorMessage('logout', 503, 'saving_unavailable'), "You're signed out. It may take a moment to be recorded.");
  assert.strictEqual(AV.errorMessage('keyCreate', 503, 'saving_unavailable'), "We couldn't save your new key, so you have no working agent key right now. Try again in a minute.");
  assert.strictEqual(AV.errorMessage('keyRevoke', 503, 'saving_unavailable'), "We couldn't save that just now, so your agent key may still work. Try again in a minute.");
  assert.strictEqual(AV.errorMessage('keyCreate', 401, 'signin_required'), 'Your sign-in has ended. Sign in again to create an agent key.');
  assert.strictEqual(AV.errorMessage('logout', 403, 'origin'), 'Please reload the page and try again.');
  // logout needs no session, so it has no 401 sentence
  assert.strictEqual(AV.errorMessage('logout', 401, 'signin_required'), AV.errorMessage('logout', 401));
  for (const a of ACTIONS) for (const c of ['origin', 'content_type', 'saving_unavailable']) {
    const s = AV.errorMessage(a, 599, c);
    assert.notStrictEqual(s, AV.errorMessage(a, 599), `${a} ${c}`);
    assert.ok(!JARGON.test(s) && !/built-in AI/i.test(s), s);
  }
});

test('KEY_PATTERN: only a key the server could have made (bh_ and at least 20 URL-safe characters)', () => {
  assert.ok(AV.KEY_PATTERN.test('bh_' + 'A'.repeat(43)));
  assert.ok(AV.KEY_PATTERN.test('bh_aB3-_' + 'x'.repeat(15)));
  assert.ok(AV.KEY_PATTERN.test('bh_' + 'x'.repeat(20)));
  for (const bad of ['', 'bh_', 'bh_short', 'bh_' + 'x'.repeat(19), 'xx_' + 'x'.repeat(30), ' bh_' + 'x'.repeat(30), 'bh_' + 'x'.repeat(30) + '\n', 'bh_' + 'x'.repeat(20) + ' y', 'bh_' + 'x'.repeat(19) + '<', 'BH_' + 'x'.repeat(30), 'bh_' + 'x'.repeat(30) + '"; rm -rf']) assert.ok(!AV.KEY_PATTERN.test(bad), JSON.stringify(bad));
});

test('the /ui guide shows the words this module returns: its header slot and key panel strings are the real ones', () => {
  const guide = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  const shown = AV.keyPanel(ME_IN, { key: 'bh_' + 'x'.repeat(30), createdAt: 1 }, '/connect');
  const none = AV.keyPanel(ME_IN, null, '/connect');
  const strings = [
    AV.slot(ME_OUT, '/').text, AV.slot(ME_OUT, '/').short, AV.slot(ME_OUT, '/spec').href, AV.slot(ME_IN, '/').who, AV.slot(ME_IN, '/').hint, AV.slot(ME_IN, '/').signOut,
    none.title, none.lead, none.create,
    shown.lead, shown.field.label, shown.field.note, shown.field.button, shown.warning, shown.create, shown.revoke,
  ];
  for (const s of strings) assert.ok(guide.includes(s), 'the guide does not show: ' + s);
});

test('account-view is pure: no DOM, UI, markup or storage', () => {
  assertClean();
});
