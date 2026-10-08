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

const KID_A = '0123456789ab';
const KID_B = 'fedcba987654';
const T0 = Date.UTC(2026, 9, 3, 23, 59, 59);
const ME_OFF = { signin: 'off', user: null, agentKeys: [] };
const ME_OUT = { signin: 'github', user: null, agentKeys: [] };
const ME_IN = { signin: 'github', user: { login: 'octocat' }, agentKeys: [] };
const KEY_NAMED = { kid: KID_A, name: 'Claude Desktop', createdAt: T0, lastUsedAt: Date.UTC(2026, 9, 5, 1) };
const KEY_PLAIN = { kid: KID_B, name: null, createdAt: T0, lastUsedAt: null };
const ME_KEY = { signin: 'github', user: { login: 'octocat' }, agentKeys: [KEY_NAMED] };
const ME_KEYS = { signin: 'github', user: { login: 'octocat' }, agentKeys: [KEY_NAMED, KEY_PLAIN] };
const NEW_KEY = { key: 'bh_THE-SECRET-KEY-VALUE', kid: KID_A };

// ---------- signinHref ----------
test('signinHref: the page the person is on comes back after sign-in when it is one of the allowed pages, else no next', () => {
  assert.strictEqual(AV.signinHref('/'), '/auth/github?next=/');
  assert.strictEqual(AV.signinHref('/start'), '/auth/github?next=/start');
  assert.strictEqual(AV.signinHref('/connect'), '/auth/github?next=/connect');
  assert.strictEqual(AV.signinHref('/key'), '/auth/github?next=/key');
  for (const p of ['/spec', '/room/abc', '/start/', '/connect?x=1', '', undefined, null, 7, '//evil.test', 'https://evil.test', '/\\evil.test', '/ui/']) {
    assert.strictEqual(AV.signinHref(p), '/auth/github', String(p));
  }
});

test('the constants this module repeats are the server\'s: the name length, the key limit and the shape of a kid', () => {
  const server = require('../lib/auth');
  assert.strictEqual(AV.KEY_NAME_MAX, server.KEY_NAME_MAX);
  assert.strictEqual(AV.MAX_KEYS, server.MAX_KEYS_PER_USER);
  assert.strictEqual(AV.KID.source, server.KID.source);
  assert.strictEqual(AV.KID.flags, server.KID.flags);
  assert.ok(AV.errorMessage('keyCreate', 409, 'key_limit').includes('(' + server.MAX_KEYS_PER_USER + ')'), 'the limit sentence names the limit');
  assert.ok(AV.errorMessage('keyCreate', 400, 'key_name').includes(server.KEY_NAME_MAX + ' characters'), 'the name sentence names the length');
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
  assert.deepStrictEqual([...AV.SIGNIN_NEXT].sort(), ['/', '/connect', '/key', '/start'], 'widening where a sign-in may return is a reviewed change');
  assert.deepStrictEqual([...AV.SIGNIN_NEXT].sort(), [...require('../lib/auth').NEXT_PATHS].sort(), 'the two lists are the same');
});

// ---------- parseMe ----------
test('parseMe: reads /api/me into the three fields and nothing else', () => {
  assert.deepStrictEqual(AV.parseMe({ user: null, signin: 'off', agentKeys: [] }), ME_OFF);
  assert.deepStrictEqual(AV.parseMe({ user: null, signin: 'github', agentKeys: [] }), ME_OUT);
  assert.deepStrictEqual(AV.parseMe({ user: { login: 'octocat', id: '1001', email: 'x' }, signin: 'github', agentKeys: [], extra: 1 }), ME_IN);
  assert.deepStrictEqual(AV.parseMe({ user: { login: ' octocat ' }, signin: 'github', agentKeys: [{ kid: KID_A, name: ' Claude Desktop ', createdAt: 5, lastUsedAt: 6, key: 'leak', id: 'leak' }] }),
    { signin: 'github', user: { login: 'octocat' }, agentKeys: [{ kid: KID_A, name: 'Claude Desktop', createdAt: 5, lastUsedAt: 6 }] });
});

test('parseMe: anything that is not that shape is null, and keys without a user, or without a well-formed kid, are dropped', () => {
  for (const bad of [null, undefined, 'x', 7, [], {}, { signin: 'on' }, { signin: 'GitHub' }, { signin: ['github'] }, { user: null }]) assert.strictEqual(AV.parseMe(bad), null, JSON.stringify(bad));
  assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: null, agentKeys: [KEY_NAMED] }).agentKeys, [], 'a key with no user is not a key');
  assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: { login: 7 } }).user, { login: '' }, 'a login that is not text is empty');
  assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: {} }).user, { login: '' });
  assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: { login: 'a' } }).agentKeys, [], 'no list is an empty one');
  for (const agentKeys of ['yes', {}, null, 7]) assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: { login: 'a' }, agentKeys }).agentKeys, [], JSON.stringify(agentKeys));
  for (const kid of [undefined, null, 7, '', 'ABCDEF012345', 'abcdef01234', 'abcdef0123456', 'abcdef01234g', ['abcdef012345']]) {
    assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: { login: 'a' }, agentKeys: [{ kid, name: 'x', createdAt: 1 }, null, 'x'] }).agentKeys, [], JSON.stringify(kid));
  }
  for (const createdAt of ['5', NaN, Infinity, null, undefined, {}]) assert.deepStrictEqual(AV.parseMe({ signin: 'github', user: { login: 'a' }, agentKeys: [{ kid: KID_A, createdAt }] }).agentKeys, [{ kid: KID_A, name: null, createdAt: null, lastUsedAt: null }], String(createdAt));
  for (const name of [7, {}, [], '', '   ', null]) assert.strictEqual(AV.parseMe({ signin: 'github', user: { login: 'a' }, agentKeys: [{ kid: KID_A, name }] }).agentKeys[0].name, null, JSON.stringify(name));
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
  assert.deepStrictEqual(AV.slot({ signin: 'github', user: { login: '' }, agentKeys: [] }, '/'), { kind: 'signed-in', who: 'Signed in', hint: '', signOut: 'Sign out' });
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
    const p = AV.keyPanel(ME_OUT, held, '/key');
    assert.strictEqual(p.state, 'signed-out');
    assert.strictEqual(p.title, 'Get an agent key');
    assert.deepStrictEqual(p.signin, { text: 'Sign in with GitHub', href: '/auth/github?next=/key' }, 'signing in comes back through /key to the panel');
    assert.deepStrictEqual([p.create, p.nameField, p.field, p.warning, p.commandNote], [null, null, null, null, null]);
    assert.deepStrictEqual(p.keys, []);
    assert.match(p.lead, /sign in first/);
    assert.ok(!JSON.stringify(p).includes(NEW_KEY.key));
  }
});

test('keyPanel: signed in with no key offers to make one, and explains what an agent key is once', () => {
  const p = AV.keyPanel(ME_IN, null, '/connect');
  assert.strictEqual(p.state, 'no-key');
  assert.strictEqual(p.title, 'Get an agent key');
  assert.strictEqual(p.create, 'Create key');
  assert.deepStrictEqual(p.nameField, { label: 'Which app is this for?' });
  assert.deepStrictEqual(p.keys, []);
  assert.strictEqual(p.signin, null);
  assert.match(p.lead, / Create one, then add it to your app\.$/);
  assert.match(p.lead, /^An agent key lets one of your own AI apps, like Claude Desktop or Claude Code, start rooms on Behalf for you\. Make one key for each app\./);
  assert.strictEqual(p.commandNote, null, 'the command has no header when there is no key');
  assert.strictEqual(p.commandKey, null);
});

test('keyPanel: each key is a row with its name (or the date it was made), when it was made, when it was last used, and its own Delete', () => {
  const p = AV.keyPanel(ME_KEYS, null, '/connect');
  assert.strictEqual(p.state, 'has-key');
  assert.strictEqual(p.title, 'Your agent keys');
  assert.deepStrictEqual(p.keys, [
    { kid: KID_A, label: 'Claude Desktop', created: 'Created 3 Oct 2026', lastUsed: 'Last used 5 Oct 2026', remove: 'Delete', removeName: 'Delete Claude Desktop' },
    { kid: KID_B, label: 'Agent key (created 3 Oct 2026, fedc)', created: 'Created 3 Oct 2026', lastUsed: 'Not used yet', remove: 'Delete', removeName: 'Delete Agent key (created 3 Oct 2026, fedc)' },
  ]);
  assert.strictEqual(p.lead, "Use one key for each app. We can't show a key again after you create it. To change an app's key, create a new one for it, then delete the old one.");
  assert.strictEqual(p.create, 'Create key', 'creating another key is always offered');
  assert.deepStrictEqual(p.nameField, { label: 'Which app is this for?' });
  assert.strictEqual(p.field, null);
  assert.strictEqual(p.commandNote, 'In this command, replace YOUR_AGENT_KEY with your key.');
  assert.strictEqual(p.commandKey, 'YOUR_AGENT_KEY', 'the command carries the word the note names');
  // a key with no date at all, and one with a name that is only blanks
  const bare = AV.keyPanel({ ...ME_IN, agentKeys: [{ kid: KID_A, name: null, createdAt: null, lastUsedAt: null }] }, null, '/connect');
  assert.deepStrictEqual([bare.keys[0].label, bare.keys[0].created, bare.keys[0].lastUsed], ['Agent key (0123)', null, 'Not used yet']);
});

test('keyLabel: the name, else "Agent key (created <date>, <first 4 of the kid>)" so two made on one day differ', () => {
  assert.strictEqual(AV.keyLabel(KEY_NAMED), 'Claude Desktop');
  assert.strictEqual(AV.keyLabel(KEY_PLAIN), 'Agent key (created 3 Oct 2026, fedc)');
  assert.notStrictEqual(AV.keyLabel(KEY_PLAIN), AV.keyLabel({ ...KEY_PLAIN, kid: '0123456789ab' }));
  assert.strictEqual(AV.keyLabel({ name: '', createdAt: Date.UTC(2026, 0, 1), kid: KID_A }), 'Agent key (created 1 Jan 2026, 0123)');
  assert.strictEqual(AV.keyLabel({ name: '', createdAt: Date.UTC(2026, 0, 1) }), 'Agent key (created 1 Jan 2026)');
  assert.strictEqual(AV.keyLabel({ kid: KID_A }), 'Agent key (0123)');
  assert.strictEqual(AV.keyLabel({ kid: 'not-a-kid' }), 'Agent key');
  assert.strictEqual(AV.keyLabel({}), 'Agent key');
  assert.strictEqual(AV.keyLabel(null), 'Agent key');
  assert.strictEqual(AV.keyDeleted('Claude Desktop'), 'Claude Desktop no longer works.');
  assert.strictEqual(AV.keyDeleted(null), 'Your agent key no longer works.');
});

test('keyPanel: the new key is shown once, in a copy field with a warning, and is never part of what this module returns', () => {
  const p = AV.keyPanel(ME_IN, NEW_KEY, '/connect');
  assert.strictEqual(p.state, 'new-key');
  assert.strictEqual(p.title, 'Your agent keys');
  assert.deepStrictEqual(p.field, { label: 'Your key', note: "Anyone with this key can open rooms as you. It is saved in your app's settings and your command history, so treat it like a password.", button: 'Copy key' });
  assert.strictEqual(p.lead, 'Your new key is below, and the command in step 1 now includes it.');
  assert.strictEqual(p.warning, "Copy it now. We can't show it again.");
  assert.strictEqual(p.create, 'Create key');
  assert.match(p.commandNote, /has your new agent key in it/);
  assert.strictEqual(p.commandKey, NEW_KEY.key, 'the command carries the new key');
  assert.ok(!JSON.stringify({ ...p, commandKey: null }).includes(NEW_KEY.key), 'the key is nowhere else: the page sets the field from its own copy');
  // the same wins over existing keys: the key just made is what the page shows, and the list is still there
  const both = AV.keyPanel(ME_KEYS, NEW_KEY, '/connect');
  assert.strictEqual(both.state, 'new-key');
  assert.strictEqual(both.keys.length, 2);
  // a held key that is empty or not text is not a key
  for (const held of [{ key: '' }, { key: 7 }, {}, { kid: KID_A }]) assert.strictEqual(AV.keyPanel(ME_IN, held, '/connect').state, 'no-key', JSON.stringify(held));
  assert.strictEqual(AV.keyPanel(ME_KEY, { key: '' }, '/connect').state, 'has-key');
});

test('every sentence a person reads here avoids protocol jargon, and says "agent key", not "token" or "API key"', () => {
  const strings = [];
  const collect = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect); };
  for (const me of [ME_OUT, ME_IN, ME_KEY, ME_KEYS]) for (const held of [null, NEW_KEY]) { collect(AV.keyPanel(me, held, '/connect')); collect(AV.slot(me, '/')); }
  collect(AV.startPrompt());
  collect([AV.SIGNIN_FAILED, AV.keyDeleted('Claude Desktop'), AV.keyDeleted(null), AV.SIGNED_OUT]);
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
  assert.strictEqual(AV.errorMessage('keyCreate', 503, 'saving_unavailable'), "We couldn't save your new key. Your other keys still work. Try again in a minute.");
  assert.strictEqual(AV.errorMessage('keyRevoke', 503, 'saving_unavailable'), "We couldn't save that just now, so that key may still work. Your other keys are not affected. Try again in a minute.");
  assert.strictEqual(AV.errorMessage('keyCreate', 401, 'signin_required'), 'Your sign-in has ended. Sign in again to create an agent key.');
  assert.match(AV.errorMessage('keyCreate', 409, 'key_limit'), /^You have as many agent keys as you can keep \(10\)\. Delete one/);
  assert.strictEqual(AV.errorMessage('keyCreate', 400, 'key_name'), 'Use a name of up to 40 characters.');
  assert.strictEqual(AV.errorMessage('keyCreate', 400, 'key_name_taken'), 'You already have a key with that name. Choose another one.');
  assert.strictEqual(AV.errorMessage('keyCreate', 400), AV.errorMessage('keyCreate', 500), 'a 400 with no code is a page that sent something broken: the action default');
  assert.strictEqual(AV.errorMessage('keyRevoke', 400), AV.errorMessage('keyRevoke', 500), 'a delete that named no key has no sentence of its own');
  assert.strictEqual(AV.errorMessage('logout', 403, 'origin'), 'Please reload the page and try again.');
  // logout needs no session, so it has no 401 sentence
  assert.strictEqual(AV.errorMessage('logout', 401, 'signin_required'), AV.errorMessage('logout', 401));
  for (const a of ACTIONS) for (const c of ['origin', 'content_type', 'saving_unavailable', ...(a === 'keyCreate' ? ['key_limit', 'key_name', 'key_name_taken'] : [])]) {
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
  const shown = AV.keyPanel(ME_KEYS, { key: 'bh_' + 'x'.repeat(30), kid: KID_A }, '/connect');
  const none = AV.keyPanel(ME_IN, null, '/connect');
  const has = AV.keyPanel(ME_KEYS, null, '/connect');
  const strings = [
    AV.slot(ME_OUT, '/').text, AV.slot(ME_OUT, '/').short, AV.slot(ME_OUT, '/spec').href, AV.slot(ME_IN, '/').who, AV.slot(ME_IN, '/').hint, AV.slot(ME_IN, '/').signOut,
    none.title, none.lead, none.create, none.nameField.label,
    has.title, has.lead, has.keys[0].label, has.keys[0].created, has.keys[0].lastUsed, has.keys[0].remove, has.keys[0].removeName, has.keys[1].label, has.keys[1].lastUsed,
    shown.lead, shown.field.label, shown.field.note, shown.field.button, shown.warning, shown.create,
  ];
  for (const s of strings) assert.ok(guide.includes(s), 'the guide does not show: ' + s);
});

test('account-view is pure: no DOM, UI, markup or storage', () => {
  assertClean();
});
