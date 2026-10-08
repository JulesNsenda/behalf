'use strict';
// "Use our AI" access (lib/ai-access.js, lib/durable.js) on its own, then through the domain (the gate, the room.ai stamp, the
// quota, the passcode) and over HTTP in-process (/api/me, /api/me/ai-access, /api/admin/ai-access, MCP create_room).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createAiAccess, NOTE_MAX, MAX_PENDING, MAX_LISTED } = require('../lib/ai-access');
const { createDurable, createPersist } = require('../lib/durable');
const { ADMIN_DAILY } = require('../lib/rooms');
const { createApp } = require('../lib/app');
const { createStore } = require('../lib/store');
const { loadConfig, loadSecrets } = require('../lib/config');
const { createLog } = require('../lib/log');
const { rateKey } = require('../lib/net');
const { mkTmp, rmTmp } = require('../test-support/server');
const { quietLog } = require('../test-support/app');

const T = { timeout: 30000 };
const PUBLIC = 'https://behalf.test';
const CLIENT_ID = 'client-id-VALUE';
const CLIENT_SECRET = 'client-secret-VALUE';
const OAUTH = '__Host-behalf_oauth';
const SESSION = '__Host-behalf_session';
const MIN = 60 * 1000;
const AI_SENTENCE = `Our AI needs approval first. Ask for "Use our AI" access at ${PUBLIC}/start, or have both sides bring their own AI.`;
const USERS = { 1001: 'octocat', 1002: 'granted-one', 1003: 'the-admin', 1004: 'other-user', 666: 'blocked-one' };
const ADMIN = '1003';

const mkClock = (t = 1700000000000) => { const c = { t, now: () => c.t }; return c; };
const capture = () => { const out = []; return { out, log: createLog({ stream: { write: (s) => out.push(s) } }) }; };

// A store handle a test can watch (persist) and make fail (failing).
function wrapStore(store, { persist } = {}) {
  const w = Object.create(store);
  w.persistCalls = [];
  w.failing = false;
  w.persist = async (kind, id) => { w.persistCalls.push([kind, id]); return persist ? persist(kind, id) : store.persist(kind, id); };
  w.health = () => (w.failing ? { ok: false, failingSince: 1 } : store.health());
  return w;
}
const canRevokeOf = (store) => () => store.health().failingSince === null;

function openStore(file, log) {
  const store = createStore({ file, log: log || quietLog() });
  store.load();
  return store;
}

// ---------- the module on its own ----------
function mkAccess(t, { users = USERS, blocked = ['666'], admins = [ADMIN], persist, clock = mkClock(), file, seed } = {}) {
  const dir = mkTmp('aiaccess-unit-');
  const { out, log } = capture();
  const base = openStore(file || path.join(dir, 'rooms.json'), log);
  t.after(async () => { await base.close(); rmTmp(dir); });
  const store = wrapStore(base, { persist });
  const config = loadConfig({ SIGNIN: 'github', PUBLIC_URL: PUBLIC, ADMIN_GITHUB_IDS: admins.join(',') });
  const userInfo = (id) => (Object.hasOwn(users, id) && !blocked.includes(id) ? { id, login: users[id] } : null);
  if (seed) seed(store.collection('aiaccess').map); // records from a previous run: the pending count is taken at construction
  const notified = [];
  const ai = createAiAccess({ store, config, canRevoke: canRevokeOf(store), userInfo, clock, log, notify: (u) => notified.push(u.id) });
  return { ai, store, clock, out, notified, dir, records: store.collection('aiaccess').map };
}
const U = (id) => ({ id: String(id), login: USERS[id] });

test('status: an admin is always granted, a stranger is none, and only the exact status "granted" grants', (t) => {
  const { ai, records } = mkAccess(t);
  assert.equal(ai.status(null), 'none');
  assert.equal(ai.status(undefined), 'none');
  assert.equal(ai.status({}), 'none');
  assert.equal(ai.status(U(1001)), 'none');
  assert.equal(ai.status(U(ADMIN)), 'granted');
  assert.equal(ai.canUseAi(U(ADMIN)), true);
  assert.equal(ai.isAdmin(U(ADMIN)), true);
  assert.equal(ai.isAdmin(U(1001)), false);
  assert.equal(ai.isAdmin({ id: 1003 }), false, 'a number is not an id');
  for (const [status, expected] of [['granted', 'granted'], ['requested', 'requested'], ['denied', 'denied']]) {
    records.set('1001', { status });
    assert.equal(ai.status(U(1001)), expected);
  }
  for (const damaged of [{ status: 'Granted' }, { status: ' granted' }, { status: 'granted ' }, { status: true }, { status: 1 }, { status: null }, {}, [], 'granted', 5, null, { userId: '1001' }, ['granted']]) {
    records.set('1001', damaged);
    assert.equal(ai.status(U(1001)), 'none', JSON.stringify(damaged));
    assert.equal(ai.canUseAi(U(1001)), false);
  }
  records.set('1002', { status: 'granted', userId: '1001' });
  assert.equal(ai.canUseAi(U(1001)), false, 'a userId inside the doc is ignored: the key is the user');
  assert.equal(ai.canUseAi(U(1002)), true);
});

test('request: the note is cleaned, "" and no note are allowed, and a bad note is refused with nothing kept', (t) => {
  const { ai, records, notified } = mkAccess(t);
  assert.deepEqual(ai.request(U(1001), '  hello‮\u0000   world\n'), { ok: true, status: 'requested' });
  assert.equal(records.get('1001').note, 'hello world');
  assert.equal(records.get('1001').decidedAt, null);
  assert.deepEqual(ai.request(U(1002), ''), { ok: true, status: 'requested' });
  assert.equal(records.get('1002').note, '');
  assert.deepEqual(ai.request(U(1004), undefined), { ok: true, status: 'requested' });
  assert.equal(records.get('1004').note, '');
  assert.deepEqual(notified, ['1001', '1002', '1004'], 'a new request notifies once');
  const fresh = mkAccess(t).ai;
  for (const bad of ['x'.repeat(NOTE_MAX + 1), '\ud800', 'a\udc00b', 5, null, {}, [], true]) {
    assert.deepEqual(fresh.request(U(1001), bad), { ok: false, reason: 'note' }, String(bad).slice(0, 10));
  }
  assert.equal(fresh.status(U(1001)), 'none');
  assert.deepEqual(fresh.request(U(1001), 'x'.repeat(NOTE_MAX)), { ok: true, status: 'requested' }, 'exactly 280 code points is fine');
  const emoji = mkAccess(t).ai;
  assert.deepEqual(emoji.request(U(1001), '\u{1F600}'.repeat(NOTE_MAX)), { ok: true, status: 'requested' }, 'code points, not UTF-16 units');
  assert.deepEqual(emoji.request(U(1002), '\u{1F600}'.repeat(NOTE_MAX + 1)), { ok: false, reason: 'note' });
});

test('request: a repeat updates the note and keeps the first time; a granted or denied status, and an admin, are returned unchanged', (t) => {
  const { ai, records, clock, notified } = mkAccess(t);
  ai.request(U(1001), 'first');
  const first = records.get('1001').requestedAt;
  clock.t += 1000;
  assert.deepEqual(ai.request(U(1001), 'second'), { ok: true, status: 'requested' });
  assert.equal(records.get('1001').note, 'second');
  assert.equal(records.get('1001').requestedAt, first);
  assert.deepEqual(notified, ['1001'], 'an update is not a new request');
  records.set('1002', { status: 'granted', note: 'keep', requestedAt: 1, decidedAt: 2 });
  records.set('1004', { status: 'denied', note: 'keep', requestedAt: 1, decidedAt: 2 });
  assert.deepEqual(ai.request(U(1002), 'new'), { ok: true, status: 'granted' });
  assert.deepEqual(ai.request(U(1004), 'new'), { ok: true, status: 'denied' });
  assert.deepEqual(ai.request(U(ADMIN), 'new'), { ok: true, status: 'granted' });
  assert.equal(records.get('1002').note, 'keep');
  assert.equal(records.get('1004').note, 'keep');
  assert.equal(records.has(ADMIN), false, 'an admin needs no record');
});

test('request: 5 per user per 10 minutes from its own table, and a decided status costs none of it', (t) => {
  const { ai, clock, records } = mkAccess(t);
  for (let i = 0; i < 5; i++) assert.equal(ai.request(U(1001), 'n' + i).ok, true, 'request ' + i);
  assert.deepEqual(ai.request(U(1001), 'six'), { ok: false, reason: 'rate' });
  assert.equal(records.get('1001').note, 'n4', 'a refused request changes nothing');
  assert.equal(ai.request(U(1002), 'other user').ok, true, 'another user has their own allowance');
  clock.t += 10 * MIN + 1;
  assert.equal(ai.request(U(1001), 'later').ok, true, 'the window passed');
  records.set('1004', { status: 'denied' });
  for (let i = 0; i < 20; i++) assert.deepEqual(ai.request(U(1004), 'again'), { ok: true, status: 'denied' });
  records.set('1004', { status: 'requested' });
  assert.equal(ai.request(U(1004), 'still has its allowance').ok, true);
});

test('request: at 500 pending a new request is refused; a repeat, and decided users, are not affected; decisions free slots', async (t) => {
  const users = { ...USERS };
  for (let i = 0; i < MAX_PENDING + 5; i++) users[String(5000 + i)] = 'user-' + i;
  const { ai, records } = mkAccess(t, { users, seed: (m) => { for (let i = 0; i < MAX_PENDING; i++) m.set(String(5000 + i), { status: 'requested', note: '', requestedAt: i, decidedAt: null }); } });
  assert.deepEqual(ai.request(U(1001), 'late'), { ok: false, reason: 'full' });
  assert.equal(records.has('1001'), false);
  assert.deepEqual(ai.request({ id: '5000', login: 'user-0' }, 'update'), { ok: true, status: 'requested' }, 'someone already pending can still update');
  records.set('1002', { status: 'granted' });
  records.set('1004', { status: 'denied' });
  assert.equal(ai.request(U(1002), 'x').ok, true, 'decided users are not refused');
  assert.deepEqual(await ai.decide('5001', 'deny'), { ok: true }); // one slot opens
  assert.equal(ai.request(U(1001), 'now').ok, true);
  assert.deepEqual(ai.request(U(1004), 'again'), { ok: true, status: 'denied' });
  assert.deepEqual(ai.request({ id: '5002', login: 'user-2' }, 'u'), { ok: true, status: 'requested' }, 'a repeat still updates at the cap');
  assert.deepEqual(await ai.decide('5002', 'reset'), { ok: true }, 'a reset opens a slot too');
  assert.deepEqual(await ai.decide('5003', 'grant'), { ok: true }, 'and so does a grant');
});

test('list: pending first, then granted, then denied, each newest first; blocked, vanished and damaged records are left out; only denied rows are capped', (t) => {
  const users = { ...USERS };
  for (let i = 0; i < 600; i++) users['7' + String(i).padStart(3, '0')] = 'bulk-' + i;
  const { ai, records } = mkAccess(t, { users });
  records.set('1001', { status: 'granted', note: 'n1', requestedAt: 10, decidedAt: 500 });
  records.set('1002', { status: 'requested', note: 'older', requestedAt: 100, decidedAt: null });
  records.set('1004', { status: 'requested', note: 'newer', requestedAt: 200, decidedAt: null });
  records.set(ADMIN, { status: 'denied', note: 7, requestedAt: 'x', decidedAt: 900 });
  records.set('666', { status: 'requested', note: 'blocked', requestedAt: 300 });
  records.set('424242', { status: 'requested', note: 'gone', requestedAt: 300 });
  records.set('9999', { status: 'nonsense', note: 'damaged' });
  records.set('8888', 'garbage');
  assert.deepEqual(ai.list().map((e) => [e.userId, e.login, e.status, e.note]), [
    ['1004', 'other-user', 'requested', 'newer'],
    ['1002', 'granted-one', 'requested', 'older'],
    ['1001', 'octocat', 'granted', 'n1'],
    [ADMIN, 'the-admin', 'denied', ''],
  ]);
  assert.deepEqual(ai.list()[3], { userId: ADMIN, login: 'the-admin', status: 'denied', note: '', requestedAt: null, decidedAt: 900 });
  // 600 denied rows, all newer than the old grant of 1001: the grant, every pending request and the admin's own are still listed.
  for (let i = 0; i < 600; i++) records.set('7' + String(i).padStart(3, '0'), { status: 'denied', note: '', requestedAt: i, decidedAt: 1000 + i });
  records.set(ADMIN, { status: 'granted', note: '', requestedAt: null, decidedAt: 100 });
  const all = ai.list();
  assert.equal(all.length, 2 + 2 + MAX_LISTED, 'two pending, two grants, 500 denied');
  assert.deepEqual(all.slice(0, 4).map((e) => e.userId), ['1004', '1002', '1001', ADMIN]);
  assert.ok(all.slice(4).every((e) => e.status === 'denied'));
  assert.equal(all[4].decidedAt, 1599, 'the newest denied first');
  assert.equal(all.at(-1).decidedAt, 1100, 'the 100 oldest denied are cut');
  // Many pending and many grants are never cut.
  const many = {};
  for (let i = 0; i < 700; i++) many['6' + String(i).padStart(3, '0')] = 'u' + i;
  const big = mkAccess(t, { users: many });
  for (let i = 0; i < 700; i++) big.records.set('6' + String(i).padStart(3, '0'), { status: i % 2 ? 'requested' : 'granted', note: '', requestedAt: i, decidedAt: null });
  assert.equal(big.ai.list().length, 700);
});

test('decide: grant, deny and reset take effect, are saved before the answer, record who decided, and log an event with no fields', async (t) => {
  const { ai, records, store, out, clock } = mkAccess(t);
  ai.request(U(1001), 'please, SECRETNOTE');
  clock.t += 5000;
  assert.deepEqual(await ai.decide('1001', 'grant', ADMIN), { ok: true });
  assert.equal(ai.status(U(1001)), 'granted');
  assert.equal(records.get('1001').decidedBy, ADMIN, 'the deciding admin is stored');
  assert.equal(records.get('1001').note, 'please, SECRETNOTE', 'the note is kept for the list');
  assert.equal(records.get('1001').decidedAt, clock.t);
  assert.deepEqual(store.persistCalls.at(-1), ['aiaccess', '1001']);
  assert.deepEqual(await ai.decide('1001', 'deny', ADMIN), { ok: true });
  assert.equal(ai.status(U(1001)), 'denied');
  assert.equal(records.get('1001').decidedBy, ADMIN);
  assert.deepEqual(await ai.decide('1001', 'reset', ADMIN), { ok: true });
  assert.equal(records.has('1001'), false);
  assert.equal(ai.status(U(1001)), 'none');
  assert.deepEqual(await ai.decide('1002', 'grant'), { ok: true }, 'a grant nobody asked for');
  assert.equal(records.get('1002').requestedAt, null);
  const lines = out.filter((l) => l.includes('event="ai.'));
  assert.deepEqual(lines.map((l) => /event="(ai\.[a-z]+)"/.exec(l)[1]), ['ai.granted', 'ai.denied', 'ai.reset', 'ai.granted']);
  assert.ok(lines.every((l) => /^level=info event="ai\.[a-z]+"\n$/.test(l)), 'one event per decision, no fields');
  const log = out.join('');
  assert.ok(!log.includes('SECRETNOTE') && !log.includes('1001') && !log.includes('octocat'), 'no note and no user id in the log');
  assert.ok(lines.every((l) => l.startsWith('level=info ')));
});

test('decide: an unknown or blocked user and a bad decision are refused with nothing changed', async (t) => {
  const { ai, records, store } = mkAccess(t);
  assert.deepEqual(await ai.decide('424242', 'grant'), { ok: false, reason: 'user' });
  assert.deepEqual(await ai.decide('666', 'grant'), { ok: false, reason: 'user' });
  assert.deepEqual(await ai.decide('__proto__', 'grant'), { ok: false, reason: 'user' });
  await assert.rejects(() => ai.decide('1001', 'maybe'), TypeError);
  await assert.rejects(() => ai.decide('1001', '__proto__'), TypeError);
  assert.equal(records.size, 0);
  assert.equal(store.persistCalls.length, 0);
});

test('decide is strict: while the store cannot save nothing is attempted for a grant, a deny holds in memory, and a failed grant is rolled back', async (t) => {
  let fail = false;
  const { ai, records, store } = mkAccess(t, { persist: async () => !fail });
  ai.request(U(1001), 'note');
  // The store is failing: a grant is not attempted and changes nothing.
  store.failing = true;
  assert.deepEqual(await ai.decide('1001', 'grant'), { ok: false, reason: 'saving' });
  assert.equal(ai.status(U(1001)), 'requested');
  assert.equal(store.persistCalls.length, 0, 'not even tried');
  // A deny takes effect at once and reports that it is not durable; a repeat once the store is back confirms it.
  assert.deepEqual(await ai.decide('1001', 'deny'), { ok: false, reason: 'saving' });
  assert.equal(ai.status(U(1001)), 'denied', 'the safe direction holds in memory');
  store.failing = false;
  assert.deepEqual(await ai.decide('1001', 'deny'), { ok: true });
  // A grant whose write is not confirmed is taken back.
  fail = true;
  assert.deepEqual(await ai.decide('1001', 'grant'), { ok: false, reason: 'saving' });
  assert.equal(ai.status(U(1001)), 'denied', 'rolled back to what it was');
  assert.deepEqual(await ai.decide('1002', 'grant'), { ok: false, reason: 'saving' });
  assert.equal(records.has('1002'), false, 'a grant that created the record removes it again');
  assert.deepEqual(await ai.decide('1001', 'reset'), { ok: false, reason: 'saving' });
  assert.equal(records.has('1001'), false, 'a reset also holds in memory');
  fail = false;
  assert.deepEqual(await ai.decide('1002', 'grant'), { ok: true });
});

// A persist the test holds shut until release(), then answers with result.
function gated(result = true) {
  const g = { result };
  g.open = new Promise((r) => { g.release = r; });
  g.persist = async () => { await g.open; return g.result; };
  return g;
}

test('decide: a grant counts only once it is durable; until then it is written for the store but not in force', async (t) => {
  const g = gated();
  let during = null;
  const { ai, records, store } = mkAccess(t, { persist: async (kind, id) => { during = [ai.canUseAi(U(1001)), ai.status(U(1001))]; return g.persist(kind, id); } });
  ai.request(U(1001), 'n');
  const first = ai.decide('1001', 'grant', ADMIN);
  assert.equal(ai.canUseAi(U(1001)), false, 'not while the write is pending');
  assert.equal(ai.status(U(1001)), 'requested');
  assert.equal(records.get('1001').status, 'granted', 'the map holds it, for the store to save');
  assert.deepEqual(ai.list().map((e) => e.status), ['requested'], 'the list shows what is in force');
  assert.deepEqual(ai.request(U(1001), 'again'), { ok: true, status: 'requested' }, 'a request meanwhile does not overwrite the grant');
  assert.equal(records.get('1001').status, 'granted');
  const second = ai.decide('1001', 'grant', ADMIN);
  g.release();
  assert.deepEqual([await first, await second], [{ ok: true }, { ok: true }]);
  assert.deepEqual(during, [false, 'requested'], 'not in force while the store was writing');
  assert.equal(store.persistCalls.length, 1, 'a second grant shares the first');
  assert.equal(ai.canUseAi(U(1001)), true);
  assert.equal(ai.list()[0].status, 'granted');
});

test('decide: a grant that fails is never usable and is rolled back; a pending request counts again', async (t) => {
  const g = gated(false);
  const seen = [];
  const { ai, records } = mkAccess(t, { persist: async (kind, id) => { seen.push(ai.canUseAi(U(1001))); return g.persist(kind, id); } });
  ai.request(U(1001), 'n');
  const before = records.get('1001');
  const p = ai.decide('1001', 'grant', ADMIN);
  g.release();
  assert.deepEqual(await p, { ok: false, reason: 'saving' });
  assert.deepEqual(seen, [false]);
  assert.equal(ai.canUseAi(U(1001)), false);
  assert.equal(records.get('1001'), before, 'the very record it replaced is back');
  assert.equal(ai.status(U(1001)), 'requested');
});

test('decide: a deny or reset that comes in during a failing grant stays; the rollback never undoes it', async (t) => {
  const g = gated(false);
  const { ai, records } = mkAccess(t, { persist: g.persist });
  ai.request(U(1001), 'n');
  const grantP = ai.decide('1001', 'grant', ADMIN);
  const denyP = ai.decide('1001', 'deny', ADMIN);
  assert.equal(ai.status(U(1001)), 'denied', 'a deny takes effect at once');
  g.release();
  assert.deepEqual(await grantP, { ok: false, reason: 'saving' });
  await denyP;
  assert.equal(ai.status(U(1001)), 'denied', 'still denied');
  assert.equal(records.get('1001').status, 'denied');
  // The same for a reset, and for a user who had no record.
  const h = gated(false);
  const two = mkAccess(t, { persist: h.persist });
  const grant2 = two.ai.decide('1002', 'grant', ADMIN);
  const reset2 = two.ai.decide('1002', 'reset', ADMIN);
  h.release();
  await Promise.all([grant2, reset2]);
  assert.equal(two.records.has('1002'), false);
  assert.equal(two.ai.canUseAi(U(1002)), false);
});

test('decide: a grant that the store confirms but a deny replaced meanwhile is not made', async (t) => {
  const g = gated(true);
  const { ai } = mkAccess(t, { persist: g.persist });
  const grantP = ai.decide('1001', 'grant', ADMIN);
  const denyP = ai.decide('1001', 'deny', ADMIN);
  g.release();
  assert.deepEqual(await grantP, { ok: false, reason: 'saving' });
  assert.deepEqual(await denyP, { ok: true });
  assert.equal(ai.status(U(1001)), 'denied');
});

test('decide: a grant is there after a restart, and so is a reset', async (t) => {
  const first = mkAccess(t);
  await first.ai.decide('1001', 'grant');
  await first.ai.decide('1002', 'grant');
  await first.ai.decide('1002', 'reset');
  assert.equal(await first.store.settle(), true);
  const file = path.join(first.dir, 'rooms.json');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).aiaccess['1001'], 'written under the kind table\'s key');
  const second = mkAccess(t, { file });
  assert.equal(second.ai.canUseAi(U(1001)), true);
  assert.equal(second.ai.status(U(1002)), 'none');
});

test('createDurable: unconfirmed until the store confirms, nothing tried while revocations are refused', async () => {
  const calls = [];
  let ok = false;
  let allowed = true;
  const { durable, unconfirmed } = createDurable({ store: { persist: async (kind, id) => { calls.push([kind, id]); return ok; } }, canRevoke: () => allowed });
  assert.equal(await durable('k', ['a', 'b'], 'u'), false);
  assert.deepEqual([...unconfirmed.keys()], ['k:a', 'k:b']);
  assert.deepEqual(unconfirmed.get('k:a'), { kind: 'k', id: 'a', userId: 'u' });
  ok = true;
  assert.equal(await durable('k', ['a', 'b'], 'u'), true);
  assert.equal(unconfirmed.size, 0);
  allowed = false;
  calls.length = 0;
  assert.equal(await durable('k', ['c'], 'u'), false);
  assert.equal(calls.length, 0);
  assert.equal(unconfirmed.size, 1);
  assert.throws(() => createDurable({ store: {} }), TypeError);
});

test('createPersist: true only when every record is confirmed, and nothing is tried while revocations are refused', async () => {
  const calls = [];
  let allowed = true;
  const persist = createPersist({ store: { persist: async (kind, id) => { calls.push([kind, id]); return id !== 'bad'; } }, canRevoke: () => allowed });
  assert.equal(await persist('k', ['a', 'b']), true);
  assert.deepEqual(calls, [['k', 'a'], ['k', 'b']]);
  assert.equal(await persist('k', ['a', 'bad']), false);
  allowed = false;
  calls.length = 0;
  assert.equal(await persist('k', ['a']), false);
  assert.equal(calls.length, 0);
  assert.throws(() => createPersist({ store: {} }), TypeError);
});

// ---------- the app ----------
function fakeGithub() {
  const gh = { id: 1001, login: 'octocat', challenge: null };
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  gh.fetch = async (url, init = {}) => {
    if (String(url) === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(init.body);
      const pkce = crypto.createHash('sha256').update(String(body.code_verifier)).digest('base64url') === gh.challenge;
      return pkce ? json({ access_token: 'gho_X', token_type: 'bearer', scope: '' }) : json({ error: 'bad_verification_code' });
    }
    return json({ id: gh.id, login: gh.login });
  };
  return gh;
}

// A live proxy that counts what it was asked and plays no turns.
function liveProxy(live = true) {
  const p = { drafts: 0, audits: 0, turns: 0, live: () => live, MODEL: 'fake' };
  p.takeTurn = async () => { p.turns++; throw new Error('unused'); };
  p.draftCard = async () => { p.drafts++; return { principal: { name: 'x' }, goal: 'g', must_haves: ['m'] }; };
  p.mapAuthority = async (room, terms) => { p.audits++; return terms.map((term) => ({ term, A: 'must_haves', B: 'must_haves', note: 'n' })); };
  return p;
}

function request(base, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, cookies: res.headers['set-cookie'] || [], text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const cookieValue = (res, name) => {
  const line = res.cookies.find((c) => c.startsWith(name + '='));
  return line === undefined ? null : line.slice(name.length + 1).split(';')[0];
};

// signin: 'github' or 'off'. env: extra variables for loadConfig. secretsEnv: extra secrets (ROOM_PASSCODE).
async function boot(t, { signin = 'github', env = {}, secretsEnv = {}, proxy = liveProxy(), persist, listen = true } = {}) {
  const dir = mkTmp('aiaccess-app-');
  const { out, log } = capture();
  const config = loadConfig({
    SIGNIN: signin, DROP_DATA_DIR: path.join(dir, 'data'), PUBLIC_URL: PUBLIC, GITHUB_BLOCKED_IDS: '666', ADMIN_GITHUB_IDS: ADMIN,
    PER_IP_DAILY: '100', PER_USER_DAILY: '100', DAILY_ROOM_LIMIT: '100', ...env,
  });
  const base = openStore(path.join(dir, 'data', 'rooms.json'), log);
  const store = wrapStore(base, { persist });
  const clock = mkClock(Date.now());
  const gh = fakeGithub();
  const app = createApp({
    config, secrets: loadSecrets({ GITHUB_CLIENT_ID: CLIENT_ID, GITHUB_CLIENT_SECRET: CLIENT_SECRET, ...secretsEnv }), log, store, proxy,
    clock: { sleep: async () => {}, now: clock.now }, fetch: gh.fetch,
  });
  let root = null;
  if (listen) {
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    root = `http://127.0.0.1:${app.server.address().port}`;
  }
  t.after(async () => { await app.drain().catch(() => {}); if (app.server.closeAllConnections) app.server.closeAllConnections(); app.close(); rmTmp(dir); });
  const h = { app, store, gh, out, clock, proxy, config, dir };
  h.req = (method, p, o) => request(root, method, p, o);
  h.post = (p, { origin = PUBLIC, cookie, type = 'application/json', body = {}, headers = {} } = {}) => {
    const hd = { ...headers };
    if (origin !== null) hd.origin = origin;
    if (cookie) hd.cookie = cookie;
    if (type !== null) hd['content-type'] = type;
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    hd['content-length'] = Buffer.byteLength(payload);
    return h.req('POST', p, { headers: hd, body: payload });
  };
  h.get = (p, cookie) => h.req('GET', p, { headers: cookie ? { cookie } : {} });
  // The browser's side of a sign-in as user `id`; resolves to the Cookie header value.
  h.signIn = async (id) => {
    gh.id = Number(id);
    gh.login = USERS[id];
    const begin = await h.req('GET', '/auth/github');
    const loc = new URL(begin.headers.location);
    gh.challenge = loc.searchParams.get('code_challenge');
    const cb = await h.req('GET', `/auth/github/callback?code=c&state=${encodeURIComponent(loc.searchParams.get('state'))}`, { headers: { cookie: `${OAUTH}=${cookieValue(begin, OAUTH)}` } });
    const session = cookieValue(cb, SESSION);
    assert.ok(session, 'signed in as ' + id);
    return `${SESSION}=${session}`;
  };
  return h;
}

// A user record, so the domain tests can pass { id, login } without a sign-in.
function addUser(app, id) {
  app.store.collection('user').map.set(String(id), { id: String(id), login: USERS[id], createdAt: 1, lastLoginAt: 1 });
  return U(id);
}
const body = (extra = {}) => ({ topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'external', modeB: 'external', ...extra });
const BUILTIN = { modeA: 'builtin', modeB: 'builtin' };
const grant = (h, id) => h.app.store.collection('aiaccess').map.set(String(id), { status: 'granted', note: '', requestedAt: null, decidedAt: 1 });
const aiAccess = (e) => e.code === 403 && e.apiCode === 'ai_access' && e.message === AI_SENTENCE;

test('the gate: a user without access cannot open a room with a built-in seat, on either seat, and nothing is counted', T, async (t) => {
  const h = await boot(t, { listen: false });
  const user = addUser(h.app, 1001);
  assert.throws(() => h.app.domain.createLiveRoom('203.0.113.1', { topic: 'T' }, user), aiAccess, 'no mode at all is a built-in seat');
  for (const modes of [BUILTIN, { modeA: 'builtin', modeB: 'external' }, { modeA: 'external', modeB: 'builtin' }, { modeA: 'builtin' }]) {
    assert.throws(() => h.app.domain.createLiveRoom('203.0.113.1', body(modes), user), aiAccess, JSON.stringify(modes));
  }
  assert.equal(h.app.domain.rooms.size, 0);
  assert.equal(h.app.store.state.usage.total, 0);
  assert.deepEqual(Object.keys(h.app.store.state.usage.byUser), []);
  // Own AI on both seats is open to anyone signed in, and is stamped.
  const room = h.app.domain.createLiveRoom('203.0.113.1', body(), user);
  assert.equal(room.ai, false);
  assert.deepEqual([room.seats.A.mode, room.seats.B.mode], ['external', 'external']);
});

test('the gate: a granted user and an admin may use built-in seats, and the room is stamped ai=true', T, async (t) => {
  const h = await boot(t, { listen: false });
  grant(h, 1002);
  const granted = h.app.domain.createLiveRoom('203.0.113.1', body(BUILTIN), addUser(h.app, 1002));
  assert.equal(granted.ai, true);
  assert.deepEqual([granted.seats.A.mode, granted.seats.B.mode], ['builtin', 'builtin']);
  const admin = h.app.domain.createLiveRoom('203.0.113.1', body({ modeA: 'external', modeB: 'builtin' }), addUser(h.app, ADMIN));
  assert.equal(admin.ai, true);
  const own = h.app.domain.createLiveRoom('203.0.113.1', body(), addUser(h.app, ADMIN));
  assert.equal(own.ai, true, 'an all-external room of someone with access is stamped true too');
});

test('the gate: a pending and a denied user have no access; a later grant does not change an old room', T, async (t) => {
  const h = await boot(t, { listen: false });
  const user = addUser(h.app, 1001);
  h.app.aiAccess.request(user, 'please');
  assert.throws(() => h.app.domain.createLiveRoom('203.0.113.1', body(BUILTIN), user), aiAccess, 'pending');
  await h.app.aiAccess.decide('1001', 'deny');
  assert.throws(() => h.app.domain.createLiveRoom('203.0.113.1', body(BUILTIN), user), aiAccess, 'denied');
  const early = h.app.domain.createLiveRoom('203.0.113.1', body(), user);
  await h.app.aiAccess.decide('1001', 'grant');
  assert.equal(h.app.domain.createLiveRoom('203.0.113.1', body(BUILTIN), user).ai, true, 'granted');
  assert.equal(early.ai, false, 'the room keeps the opener\'s status at the time');
  await assert.rejects(() => h.app.domain.draftCard(early, 'A', { text: 'brief', name: 'Ann' }), aiAccess);
});

test('the gate also holds with the proxy not live: the old "not enabled" answer comes first, and nothing else changes', T, async (t) => {
  const h = await boot(t, { listen: false, proxy: liveProxy(false) });
  assert.throws(() => h.app.domain.createLiveRoom('203.0.113.1', body(BUILTIN), addUser(h.app, 1001)), (e) => e.code === 503);
  assert.equal(h.app.domain.createLiveRoom('203.0.113.1', body(), addUser(h.app, 1001)).ai, false);
});

test('draftCard: a room whose opener had no access refuses with 403 ai_access before spending anything; a room from before the stamp, and a stamped one, draft', T, async (t) => {
  const h = await boot(t, { listen: false });
  const user = addUser(h.app, 1001);
  const closed = h.app.domain.createLiveRoom('203.0.113.1', body(), user);
  assert.equal(closed.ai, false);
  await assert.rejects(() => h.app.domain.draftCard(closed, 'A', { text: 'brief', name: 'Ann' }), aiAccess);
  assert.equal(closed.seats.A.drafts || 0, 0, 'the seat\'s draft allowance was not used');
  assert.equal(h.proxy.drafts, 0, 'Claude was not asked');
  const legacy = h.app.domain.createLiveRoom('203.0.113.1', body(), user);
  delete legacy.ai; // a room stored before the stamp existed
  assert.equal((await h.app.domain.draftCard(legacy, 'A', { text: 'brief', name: 'Ann' })).goal, 'g');
  grant(h, 1002);
  const open = h.app.domain.createLiveRoom('203.0.113.1', body(BUILTIN), addUser(h.app, 1002));
  assert.equal((await h.app.domain.draftCard(open, 'A', { text: 'brief', name: 'Ann' })).goal, 'g');
  assert.equal(h.proxy.drafts, 2);
  // The old order of refusals is kept for the cases that were already refused.
  const sealed = h.app.domain.createLiveRoom('203.0.113.1', body(), user);
  h.app.domain.sealCard(sealed, 'A', { principal: { name: 'Ann' }, goal: 'g', must_haves: ['m'] }, 'test');
  await assert.rejects(() => h.app.domain.draftCard(sealed, 'A', { text: 't', name: 'Ann' }), (e) => e.code === 409);
});

test('chargeCall: the one choke point refuses every Claude call for a room with ai=false, the draft kind included', T, async (t) => {
  const h = await boot(t, { listen: false });
  const user = addUser(h.app, 1001);
  const closed = h.app.domain.createLiveRoom('203.0.113.1', body(), user);
  assert.equal(closed.ai, false);
  for (const kind of ['draft', 'turn', 'authority']) assert.throws(() => h.app.domain.chargeCall(closed, kind), aiAccess, kind);
  assert.equal(closed.apiCalls || 0, 0, 'nothing was charged');
  const open = h.app.domain.createLiveRoom('203.0.113.1', body(), user);
  delete open.ai; // a room from before the stamp
  h.app.domain.chargeCall(open, 'draft');
  h.app.domain.chargeCall(open, 'turn');
  assert.equal(open.apiCalls, 1);
  open.ai = true;
  h.app.domain.chargeCall(open, 'turn');
  assert.equal(open.apiCalls, 2);
});

test('hydrate: room.ai keeps true and false and drops any other value', T, async (t) => {
  const h = await boot(t, { listen: false });
  const user = addUser(h.app, 1001);
  const make = () => h.app.domain.createLiveRoom('203.0.113.1', body(), user);
  const rooms = [make(), make(), make(), make(), make(), make()];
  const values = [false, true, 'false', null, 0, undefined];
  rooms.forEach((r, i) => { r.ai = values[i]; });
  delete rooms[5].ai;
  h.app.domain.hydrate();
  assert.deepEqual(rooms.map((r) => (Object.hasOwn(r, 'ai') ? r.ai : 'absent')), [false, true, 'absent', 'absent', 'absent', 'absent']);
  assert.throws(() => h.app.domain.chargeCall(rooms[2], 'draft') || (() => { throw new Error('allowed'); })(), /allowed/, 'a damaged value is not a refusal');
  assert.throws(() => h.app.domain.chargeCall(rooms[0], 'draft'), aiAccess);
});

// An agreement between two external seats, driven through the domain.
async function agreeBetweenExternals(h, room) {
  const card = (n) => ({ principal: { name: n }, goal: 'g', must_haves: ['m'] });
  h.app.domain.sealCard(room, 'A', card('Ann'), 'test');
  h.app.domain.sealCard(room, 'B', card('Ben'), 'test');
  await h.app.domain.externalTurn(room, 'A', { message: 'm', status: 'continue', proposal: { terms: ['the term'], depends_on: [] } });
  await h.app.domain.externalTurn(room, 'B', { message: 'ok', status: 'agree' });
  assert.equal(room.status, 'agreed');
}

test('finalise: the authority audit is skipped for a room with ai=false, runs for ai=true and for a room with no stamp', T, async (t) => {
  const h = await boot(t, { listen: false });
  const room = (id, mutate) => {
    const r = h.app.domain.createLiveRoom('203.0.113.1', body(), addUser(h.app, id));
    mutate(r);
    return r;
  };
  const closed = room(1001, () => {});
  assert.equal(closed.ai, false);
  await agreeBetweenExternals(h, closed);
  assert.equal(h.proxy.audits, 0, 'no Claude for a room without access');
  assert.equal(closed.brief.authority, null);
  assert.equal(closed.brief.outcome, 'agreed');
  const open = room(ADMIN, () => {});
  await agreeBetweenExternals(h, open);
  assert.equal(h.proxy.audits, 1);
  assert.ok(Array.isArray(open.brief.authority));
  const legacy = room(1004, (r) => { delete r.ai; });
  await agreeBetweenExternals(h, legacy);
  assert.equal(h.proxy.audits, 2, 'a room from before the stamp is audited as it always was');
});

test('view: live is per room: false for a room without access, true for the rest, and false when the proxy is not live', T, async (t) => {
  const h = await boot(t, { listen: false });
  const closed = h.app.domain.createLiveRoom('203.0.113.1', body(), addUser(h.app, 1001));
  const open = h.app.domain.createLiveRoom('203.0.113.1', body(), addUser(h.app, ADMIN));
  const legacy = h.app.domain.createLiveRoom('203.0.113.1', body(), addUser(h.app, 1004));
  delete legacy.ai;
  const live = (r) => h.app.view(r, 'A', r.seats.A.token).live;
  assert.deepEqual([live(closed), live(open), live(legacy)], [false, true, true]);
  assert.equal(h.app.view(closed, 'A', closed.seats.A.token).seats.B.mode, 'external', 'the seats\' modes are in the view');
  const off = await boot(t, { listen: false, proxy: liveProxy(false) });
  const r = off.app.domain.createLiveRoom('203.0.113.1', body(), addUser(off.app, ADMIN));
  assert.equal(off.app.view(r, 'A', r.seats.A.token).live, false);
});

test('sign-in off: nothing changes: a built-in seat needs only the live proxy, the room is stamped ai=true, no admin routes, no aiAccess', T, async (t) => {
  const h = await boot(t, { signin: 'off', env: { ADMIN_GITHUB_IDS: '' } });
  assert.equal(h.app.aiAccess, null);
  const room = h.app.domain.createLiveRoom('203.0.113.1', body(BUILTIN));
  assert.equal(room.ai, true);
  assert.equal(h.app.view(room, 'A', room.seats.A.token).live, true);
  assert.deepEqual((await h.get('/api/me')).json, { user: null, signin: 'off', agentKeys: [], ai: 'none', admin: false });
  for (const [m, p] of [['GET', '/api/admin/ai-access'], ['POST', '/api/admin/ai-access'], ['POST', '/api/me/ai-access']]) {
    const r = m === 'GET' ? await h.get(p) : await h.post(p, { body: { userId: '1', decision: 'grant' } });
    assert.equal(r.status, 404, m + ' ' + p);
  }
  assert.ok(!h.out.join('').includes('app.no_admins'), 'no warning with sign-in off');
});

test('the passcode: asked only with sign-in off; /api/config, ops and the domain agree', T, async (t) => {
  const on = await boot(t, { secretsEnv: { ROOM_PASSCODE: 'open-sesame' } });
  assert.equal((await on.get('/api/config')).json.passcode, false);
  assert.equal(on.app.ops.passcodeRequired(), false);
  const cookie = await on.signIn(1001);
  const made = await on.post('/api/rooms', { cookie, body: body() });
  assert.equal(made.status, 201, 'no passcode, none needed');
  assert.equal((await on.post('/api/rooms', { cookie, body: body({ passcode: 'wrong' }) })).status, 201, 'a wrong one is not even looked at');
  assert.deepEqual(on.app.store.state.usage.failedByIp, Object.create(null), 'no guess was counted against the address');

  const off = await boot(t, { signin: 'off', secretsEnv: { ROOM_PASSCODE: 'open-sesame' } });
  assert.equal((await off.get('/api/config')).json.passcode, true);
  assert.equal(off.app.ops.passcodeRequired(), true);
  assert.equal((await off.post('/api/rooms', { body: body() })).status, 403);
  assert.equal((await off.post('/api/rooms', { body: body({ passcode: 'wrong' }) })).status, 403);
  assert.equal((await off.post('/api/rooms', { body: body({ passcode: 'open-sesame' }) })).status, 201);

  const none = await boot(t, { signin: 'off' });
  assert.equal((await none.get('/api/config')).json.passcode, false);
  assert.equal((await none.post('/api/rooms', { body: body() })).status, 201);
});

test('the passcode: with sign-in on it is not looked at, so an address with ten wrong guesses can still open a room', T, async (t) => {
  const ip = '203.0.113.7';
  const on = await boot(t, { listen: false, secretsEnv: { ROOM_PASSCODE: 'open-sesame' } });
  on.app.domain.createLiveRoom('203.0.113.8', body(), addUser(on.app, 1004)); // rolls the day over, so the table below is kept
  on.app.store.state.usage.failedByIp[rateKey(ip)] = 10;
  const made = on.app.domain.createLiveRoom(ip, body(), addUser(on.app, 1001));
  assert.equal(made.status, 'drafting');
  assert.equal(on.app.store.state.usage.failedByIp[rateKey(ip)], 10, 'not counted either');
  // Sign-in off, the passcode on: the same address is locked out.
  const off = await boot(t, { listen: false, signin: 'off', secretsEnv: { ROOM_PASSCODE: 'open-sesame' } });
  off.app.domain.createLiveRoom('203.0.113.8', body({ passcode: 'open-sesame' }));
  off.app.store.state.usage.failedByIp[rateKey(ip)] = 10;
  assert.throws(() => off.app.domain.createLiveRoom(ip, body({ passcode: 'open-sesame' })), (e) => e.code === 429);
});

test('boot: app.passcode_ignored is a warning when ROOM_PASSCODE is set and sign-in is on, and only then', T, async (t) => {
  const warned = (h) => h.out.filter((l) => l.includes('app.passcode_ignored'));
  const both = await boot(t, { listen: false, secretsEnv: { ROOM_PASSCODE: 'open-sesame' } });
  assert.equal(warned(both).length, 1);
  assert.match(warned(both)[0], /^level=warn event="app\.passcode_ignored"\n$/);
  assert.equal(both.app.domain.rooms.size, 0, 'it keeps running');
  assert.equal(warned(await boot(t, { listen: false })).length, 0, 'no passcode set');
  assert.equal(warned(await boot(t, { listen: false, signin: 'off', secretsEnv: { ROOM_PASSCODE: 'open-sesame' } })).length, 0, 'sign-in is off: the passcode is used');
});

test('the quota: an admin or a granted user is exempt from the global daily limit and does not count toward it; an admin has the finite ADMIN_DAILY cap, others keep theirs', T, async (t) => {
  const h = await boot(t, { listen: false, env: { DAILY_ROOM_LIMIT: '2', PER_USER_DAILY: '1' } });
  grant(h, 1002);
  const make = (id) => h.app.domain.createLiveRoom('203.0.113.1', body(), addUser(h.app, id));
  make(1001);
  make(1004);
  assert.equal(h.app.store.state.usage.total, 2);
  assert.throws(() => make(1001), (e) => e.apiCode === 'daily_limit', 'the global limit stops free accounts');
  const g = make(1002);
  assert.equal(g.ai, true, 'a granted user is past the global limit');
  assert.throws(() => make(1002), (e) => e.apiCode === 'user_limit', 'but keeps the per-user cap');
  assert.equal(h.app.store.state.usage.total, 2, 'a granted user\'s room does not count toward the global total');
  assert.equal(ADMIN_DAILY, 50);
  for (let i = 0; i < ADMIN_DAILY; i++) make(ADMIN);
  assert.equal(h.app.store.state.usage.byUser[ADMIN], ADMIN_DAILY, 'an admin\'s rooms are counted per account');
  assert.equal(h.app.store.state.usage.total, 2, 'but not toward the global total');
  assert.throws(() => make(ADMIN), (e) => e.apiCode === 'user_limit' && e.code === 429, 'the admin cap is finite');
  assert.equal(h.app.store.state.usage.byUser[ADMIN], ADMIN_DAILY, 'a refused room is not counted');
  assert.throws(() => make(1004), (e) => e.apiCode === 'daily_limit');
});

// ---------- over HTTP ----------
test('/api/me: ai and admin follow the signed-in user; signed out is none and false', T, async (t) => {
  const h = await boot(t);
  assert.deepEqual((await h.get('/api/me')).json, { user: null, signin: 'github', agentKeys: [], ai: 'none', admin: false });
  const user = await h.signIn(1001);
  assert.deepEqual((await h.get('/api/me', user)).json, { user: { login: 'octocat' }, signin: 'github', agentKeys: [], ai: 'none', admin: false });
  grant(h, 1002);
  assert.equal((await h.get('/api/me', await h.signIn(1002))).json.ai, 'granted');
  assert.equal((await h.get('/api/me', await h.signIn(1002))).json.admin, false, 'granted is not admin');
  const admin = (await h.get('/api/me', await h.signIn(ADMIN))).json;
  assert.deepEqual([admin.ai, admin.admin], ['granted', true]);
  assert.ok(!JSON.stringify(admin).includes(ADMIN), 'no id in the answer');
});

test('POST /api/me/ai-access: guards first, then the note; it answers the status and changes only none and requested', T, async (t) => {
  const h = await boot(t);
  const url = '/api/me/ai-access';
  assert.deepEqual((await h.post(url, { origin: null })).json.code, 'origin');
  assert.equal((await h.post(url, { origin: 'https://evil.test' })).status, 403);
  assert.deepEqual([(await h.post(url, { type: 'text/plain' })).status, (await h.post(url, { type: null })).json.code], [415, 'content_type']);
  const signedOut = await h.post(url, { body: { note: 'x' } });
  assert.deepEqual([signedOut.status, signedOut.json.code], [401, 'signin_required']);
  const cookie = await h.signIn(1001);
  const ok = await h.post(url, { cookie, body: { note: 'I would like to try it' } });
  assert.deepEqual([ok.status, ok.json], [200, { status: 'requested' }]);
  assert.equal(h.app.store.collection('aiaccess').map.get('1001').note, 'I would like to try it');
  assert.equal((await h.get('/api/me', cookie)).json.ai, 'requested');
  const again = await h.post(url, { cookie, body: { note: 'updated' } });
  assert.deepEqual([again.status, again.json], [200, { status: 'requested' }]);
  assert.equal(h.app.store.collection('aiaccess').map.get('1001').note, 'updated');
  assert.equal((await h.post(url, { cookie, body: {} })).status, 200, 'no note is fine');
  assert.equal((await h.post(url, { cookie, body: { note: '' } })).status, 200);
  // A bad note: 400 ai_note, a fixed sentence that does not echo it.
  for (const note of ['x'.repeat(NOTE_MAX + 1), 7, null, ['a'], '\ud800']) {
    const r = await h.post(url, { cookie, body: typeof note === 'string' && note === '\ud800' ? '{"note":"\\ud800"}' : { note } });
    assert.deepEqual([r.status, r.json.code], [400, 'ai_note'], JSON.stringify(note));
    assert.ok(!r.text.includes('xxxx'));
  }
  assert.equal((await h.post(url, { cookie, body: '[1]' })).status, 400);
  assert.equal((await h.post(url, { cookie, body: 'not json' })).status, 400);
  // A decided status is returned and not changed.
  grant(h, 1002);
  const c2 = await h.signIn(1002);
  assert.deepEqual((await h.post(url, { cookie: c2, body: { note: 'x' } })).json, { status: 'granted' });
  assert.equal(h.app.store.collection('aiaccess').map.get('1002').note, '');
  const c4 = await h.signIn(1004);
  await h.app.aiAccess.decide('1004', 'deny');
  assert.deepEqual((await h.post(url, { cookie: c4, body: { note: 'x' } })).json, { status: 'denied' });
  assert.deepEqual((await h.post(url, { cookie: await h.signIn(ADMIN), body: {} })).json, { status: 'granted' });
});

test('POST /api/me/ai-access: 5 per user per 10 minutes (429 rate_limited), and at 500 pending 503 requests_full', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  for (let i = 0; i < 5; i++) assert.equal((await h.post('/api/me/ai-access', { cookie, body: { note: 'n' } })).status, 200);
  const limited = await h.post('/api/me/ai-access', { cookie, body: { note: 'n' } });
  assert.deepEqual([limited.status, limited.json.code], [429, 'rate_limited']);
  assert.equal((await h.post('/api/me/ai-access', { cookie: await h.signIn(1004), body: {} })).status, 200, 'another user is not limited');

  const full = await boot(t);
  const records = full.app.store.collection('aiaccess').map;
  for (let i = 0; i < MAX_PENDING; i++) assert.equal(full.app.aiAccess.request({ id: String(5000 + i), login: 'bulk-' + i }, '').ok, true);
  const refused = await full.post('/api/me/ai-access', { cookie: await full.signIn(1001), body: { note: 'late' } });
  assert.deepEqual([refused.status, refused.json.code], [503, 'requests_full']);
  assert.equal(records.has('1001'), false);
});

test('GET /api/admin/ai-access: session only (no Origin, no content type); an admin gets the list, everyone else a plain 404', T, async (t) => {
  const h = await boot(t);
  const user = await h.signIn(1001);
  await h.post('/api/me/ai-access', { cookie: user, body: { note: 'let me <b>in</b> https://x.test' } });
  h.clock.t += 1000;
  await h.post('/api/me/ai-access', { cookie: await h.signIn(1004), body: { note: 'me too' } });
  const admin = await h.signIn(ADMIN);
  const r = await h.get('/api/admin/ai-access', admin); // no Origin, no content type: a browser's plain GET
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(r.json.requests.map((e) => [e.userId, e.login, e.status, e.note]), [
    ['1004', 'other-user', 'requested', 'me too'],
    ['1001', 'octocat', 'requested', 'let me <b>in</b> https://x.test'],
  ]);
  assert.deepEqual(Object.keys(r.json.requests[0]).sort(), ['decidedAt', 'login', 'note', 'requestedAt', 'status', 'userId']);
  assert.equal(r.json.requests[0].decidedAt, null);
  assert.ok(Number.isFinite(r.json.requests[0].requestedAt));
  // Not an admin: signed out, signed in, granted. All the same answer as a path that does not exist.
  grant(h, 1002);
  for (const cookie of [null, user, await h.signIn(1002), 'garbage=1']) {
    const x = await h.get('/api/admin/ai-access', cookie);
    assert.deepEqual([x.status, x.json], [404, { error: 'Not found' }], String(cookie));
  }
  for (const p of ['/api/admin', '/api/admin/', '/api/admin/ai-access/x', '/api/admin/other']) {
    assert.equal((await h.get(p, admin)).status, 404, p);
  }
  assert.equal((await h.req('PUT', '/api/admin/ai-access', { headers: { cookie: admin } })).status, 404);
  assert.equal((await h.req('DELETE', '/api/admin/ai-access', { headers: { cookie: admin } })).status, 404);
  // A blocked user's pending request is not listed.
  h.app.store.collection('aiaccess').map.set('666', { status: 'requested', note: 'x', requestedAt: 1 });
  assert.ok(!(await h.get('/api/admin/ai-access', admin)).text.includes('"666"'));
});

test('POST /api/admin/ai-access: the admin check (404) comes first, then Origin and content type, then the body; decisions are saved before the 204', T, async (t) => {
  const h = await boot(t);
  const url = '/api/admin/ai-access';
  const user = await h.signIn(1001);
  const admin = await h.signIn(ADMIN);
  const decide = (cookie, b, o = {}) => h.post(url, { cookie, body: b, ...o });
  // The admin sees the Origin and content-type rules.
  assert.equal((await decide(admin, { userId: '1001', decision: 'grant' }, { origin: null })).json.code, 'origin');
  assert.equal((await decide(admin, { userId: '1001', decision: 'grant' }, { origin: 'https://evil.test' })).json.code, 'origin');
  assert.equal((await decide(admin, { userId: '1001', decision: 'grant' }, { type: 'text/plain' })).json.code, 'content_type');
  // Not an admin (signed out included): 404 whatever the Origin, the content type or the body, so never a 401, 403 or 415. Nothing changes.
  const nobody = [null, 'garbage=1', user, await h.signIn(1004)];
  for (const cookie of nobody) {
    const r = await decide(cookie, { userId: '1001', decision: 'grant' });
    assert.deepEqual([r.status, r.json], [404, { error: 'Not found' }], String(cookie));
    assert.equal((await decide(cookie, 'not json')).status, 404, 'the body is not even read');
    assert.equal((await decide(cookie, { userId: '1001', decision: 'grant' }, { origin: null })).status, 404, 'no origin');
    assert.equal((await decide(cookie, { userId: '1001', decision: 'grant' }, { origin: 'https://evil.test' })).status, 404, 'a foreign origin');
    assert.equal((await decide(cookie, { userId: '1001', decision: 'grant' }, { type: 'text/plain' })).status, 404, 'no JSON type');
    assert.equal((await decide(cookie, { userId: '1001', decision: 'grant' }, { type: null })).status, 404, 'no type at all');
  }
  assert.equal(h.app.aiAccess.status(U(1001)), 'none');
  // The admin: bad bodies are 400 with no code.
  for (const b of [{}, { userId: '1001' }, { decision: 'grant' }, { userId: 1001, decision: 'grant' }, { userId: '1001', decision: 'maybe' },
    { userId: '1001', decision: ['grant'] }, { userId: 'abc', decision: 'grant' }, { userId: '', decision: 'grant' }, { userId: '1234567890123456', decision: 'grant' },
    { userId: '-1', decision: 'grant' }, { userId: '10 01', decision: 'grant' }, { userId: '__proto__', decision: 'grant' },
    { userId: '424242', decision: 'grant' }, { userId: '666', decision: 'grant' }, { userId: '0001001', decision: 'grant' }]) {
    const r = await decide(admin, b);
    assert.deepEqual([r.status, r.json && r.json.code], [400, undefined], JSON.stringify(b));
  }
  assert.equal((await decide(admin, '[1]')).status, 400);
  assert.equal((await decide(admin, 'not json')).status, 400);
  assert.equal(h.app.store.collection('aiaccess').map.size, 0, 'nothing changed');
  // The decisions.
  const before = h.store.persistCalls.length;
  const g = await decide(admin, { userId: '1001', decision: 'grant' });
  assert.deepEqual([g.status, g.text], [204, '']);
  assert.deepEqual(h.store.persistCalls.slice(before), [['aiaccess', '1001']], 'saved before the answer');
  assert.equal((await h.get('/api/me', user)).json.ai, 'granted');
  assert.equal((await decide(admin, { userId: '1001', decision: 'deny' })).status, 204);
  assert.equal((await h.get('/api/me', user)).json.ai, 'denied');
  assert.equal((await decide(admin, { userId: '1001', decision: 'reset' })).status, 204);
  assert.equal((await h.get('/api/me', user)).json.ai, 'none');
  assert.equal(h.app.store.collection('aiaccess').map.has('1001'), false, 'reset deletes the record');
  // One event each, with no fields: no id, no note, not even who decided.
  const log = h.out.join('');
  assert.deepEqual([...log.matchAll(/event="(ai\.[a-z]+)"([^\n]*)\n/g)].map((m) => [m[1], m[2]]), [['ai.granted', ''], ['ai.denied', ''], ['ai.reset', '']]);
  assert.equal(h.app.store.collection('aiaccess').map.size, 0);
});

test('POST /api/admin/ai-access: a decision the store cannot keep is 503 saving_unavailable', T, async (t) => {
  let ok = true;
  const h = await boot(t, { persist: async () => ok });
  const admin = await h.signIn(ADMIN);
  await h.signIn(1001); // the user exists
  ok = false;
  const r = await h.post('/api/admin/ai-access', { cookie: admin, body: { userId: '1001', decision: 'grant' } });
  assert.deepEqual([r.status, r.json.code], [503, 'saving_unavailable']);
  assert.equal(h.app.aiAccess.status(U(1001)), 'none', 'a grant that was not saved is not in force');
  h.store.failing = true;
  const calls = h.store.persistCalls.length;
  const again = await h.post('/api/admin/ai-access', { cookie: admin, body: { userId: '1001', decision: 'grant' } });
  assert.equal(again.status, 503);
  assert.equal(h.store.persistCalls.length, calls, 'the failing store was not even tried');
  const deny = await h.post('/api/admin/ai-access', { cookie: admin, body: { userId: '1001', decision: 'deny' } });
  assert.equal(deny.status, 503);
  assert.equal(h.app.aiAccess.status(U(1001)), 'denied', 'a deny holds in memory');
});

test('end to end: ask, get approved, then open a room with the built-in AI over the web; a refusal before says ai_access', T, async (t) => {
  const h = await boot(t);
  const user = await h.signIn(1001);
  const refused = await h.post('/api/rooms', { cookie: user, body: body(BUILTIN) });
  assert.deepEqual([refused.status, refused.json], [403, { error: AI_SENTENCE, code: 'ai_access' }]);
  assert.equal((await h.post('/api/rooms', { cookie: user, body: body() })).status, 201, 'own AI on both seats is open to all');
  await h.post('/api/me/ai-access', { cookie: user, body: { note: 'hello' } });
  assert.equal((await h.post('/api/rooms', { cookie: user, body: body(BUILTIN) })).status, 403, 'asking is not enough');
  const admin = await h.signIn(ADMIN);
  assert.equal((await h.post('/api/admin/ai-access', { cookie: admin, body: { userId: '1001', decision: 'grant' } })).status, 204);
  const made = await h.post('/api/rooms', { cookie: user, body: body(BUILTIN) });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.modes, { A: 'builtin', B: 'builtin' });
  // The room's view and a draft over HTTP follow the stamp.
  const roomId = made.json.id;
  const tokenA = new URL(made.json.links.A, PUBLIC).searchParams.get('t');
  const viewA = await h.get(`/api/rooms/${roomId}?seat=A&t=${tokenA}`);
  assert.equal(viewA.json.live, true);
  const closed = await h.post('/api/rooms', { cookie: await h.signIn(1004), body: body() });
  const closedToken = new URL(closed.json.links.A, PUBLIC).searchParams.get('t');
  assert.equal((await h.get(`/api/rooms/${closed.json.id}?seat=A&t=${closedToken}`)).json.live, false);
  const draft = await h.post(`/api/rooms/${closed.json.id}/seats/A/draft`, { body: { token: closedToken, text: 'a brief', name: 'Ann' }, origin: null });
  assert.deepEqual([draft.status, draft.json.code], [403, 'ai_access']);
  const okDraft = await h.post(`/api/rooms/${roomId}/seats/A/draft`, { body: { token: tokenA, text: 'a brief', name: 'Ann' }, origin: null });
  assert.equal(okDraft.status, 200);
});

const rpcHeaders = (extra = {}) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra });
const mcpCall = (h, name, args, headers = {}) => h.req('POST', '/mcp', {
  headers: rpcHeaders(headers), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
});
const toolText = (r) => r.json.result.content[0].text;

test('MCP create_room: no passcode is needed with a key; counterpart_proxy "builtin" needs access, "external" does not', T, async (t) => {
  const h = await boot(t, { secretsEnv: { ROOM_PASSCODE: 'open-sesame' } });
  const key = (await h.app.auth.mintAgentKey(addUser(h.app, 1001), 'k')).key;
  const room = { topic: 'Over MCP', your_principal: 'Ann', counterpart: 'Ben' };
  const auth = { authorization: `Bearer ${key}` };
  const external = await mcpCall(h, 'create_room', room, auth);
  assert.notEqual(external.json.result.isError, true, 'no passcode argument and none needed');
  assert.equal(external.json.result.structuredContent.counterpart_proxy, 'external');
  const builtin = await mcpCall(h, 'create_room', { ...room, counterpart_proxy: 'builtin' }, auth);
  assert.equal(builtin.json.result.isError, true);
  assert.equal(toolText(builtin), AI_SENTENCE);
  assert.equal(h.app.domain.rooms.size, 1, 'the refused one made no room');
  grant(h, 1001);
  const allowed = await mcpCall(h, 'create_room', { ...room, counterpart_proxy: 'builtin' }, auth);
  assert.notEqual(allowed.json.result.isError, true);
  assert.equal(allowed.json.result.structuredContent.counterpart_proxy, 'builtin');
});

test('/admin is a page: served with the same strict policy as the others', T, async (t) => {
  const h = await boot(t);
  const r = await h.get('/admin');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
});

test('boot: app.no_admins is a warning when sign-in is on, the built-in AI is live and no admin is set, and only then', T, async (t) => {
  const warned = (h) => h.out.filter((l) => l.includes('app.no_admins'));
  const none = await boot(t, { listen: false, env: { ADMIN_GITHUB_IDS: '' } });
  assert.equal(warned(none).length, 1);
  assert.match(warned(none)[0], /^level=warn event="app\.no_admins"\n$/);
  assert.equal(none.app.domain.rooms.size, 0, 'it keeps running');
  assert.equal(warned(await boot(t, { listen: false })).length, 0, 'an admin is set');
  assert.equal(warned(await boot(t, { listen: false, env: { ADMIN_GITHUB_IDS: '' }, proxy: liveProxy(false) })).length, 0, 'the built-in AI is off');
  assert.equal(warned(await boot(t, { listen: false, signin: 'off', env: { ADMIN_GITHUB_IDS: '' } })).length, 0, 'sign-in is off');
});

test('with no admins nobody but a granted user can use the built-in AI, and nobody can decide', T, async (t) => {
  const h = await boot(t, { env: { ADMIN_GITHUB_IDS: '' } });
  const cookie = await h.signIn(ADMIN);
  assert.deepEqual((await h.get('/api/me', cookie)).json.admin, false);
  assert.equal((await h.get('/api/admin/ai-access', cookie)).status, 404);
  assert.equal((await h.post('/api/admin/ai-access', { cookie, body: { userId: '1001', decision: 'grant' } })).status, 404);
});
