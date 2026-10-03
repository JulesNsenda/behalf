'use strict';
// Item 7, part 1, in-process: the per-room spend budget (D12) through the REAL proxy with a fake fetch, and room eviction
// (D3) driven by a controllable clock. Node-18-safe: no t.mock, no timers helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { BudgetError, ApiError } = require('../lib/rooms');
const { loadConfig, loadSecrets } = require('../lib/config');
const { createLog } = require('../lib/log');
const { ROOT } = require('../test-support/paths');
const { mkTmp, rmTmp } = require('../test-support/server');

const T = { timeout: 20000 };
const SENTENCE = 'This room has used up its AI allowance. Start a new room to keep going.';
const CARD = (name) => ({ principal: { name, role: 'tester' }, goal: 'a goal', must_haves: ['a must-have'] });
const DRAFT = { text: 'a brief', name: 'Ann' };
const HOUR = 3600000;
const DAY = 24 * HOUR;
// Ledger entries are stamped by lib/pxp with the real time, so the fake clock starts there.
const START = Date.now();
const FIXTURE = path.join(ROOT, 'test-support', 'fixtures', 'rooms.v0.json');
const LIMITS = { roomTtlDays: 30, demoTtlHours: 24, maxRooms: 5000 };

const reply = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ content: [{ type: 'text', text: body }] }) });
const turn = () => reply(JSON.stringify({ message: 'm', status: 'continue' }));
const junk = () => reply('this is not json');
const draftCard = () => reply(JSON.stringify({ principal: { name: 'x' }, goal: 'g', must_haves: ['m'] }));
const fakeProxy = (extra) => Object.assign({
  live: () => false, takeTurn: async () => { throw new Error('unused'); }, draftCard: async () => ({}), mapAuthority: async () => [], MODEL: 'fake',
}, extra);

async function settle(room) {
  for (let i = 0; i < 400 && room.running; i++) await new Promise((r) => setImmediate(r));
  assert.equal(room.running, false, 'the run settled');
}

// createApp on a temp file. `config` extras are the limits; the clock has a no-op sleep unless overridden.
function boot(t, { maxTurns = 2, config = {}, overrides = {}, content, dir: given } = {}) {
  const dir = given || mkTmp('limits-');
  if (!given) t.after(() => rmTmp(dir));
  const file = path.join(dir, 'data', 'rooms.json');
  if (content !== undefined) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  const out = [];
  const log = createLog({ stream: { write: (s) => out.push(s) } });
  const cfg = { ...loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: path.join(dir, 'data'), MAX_TURNS: String(maxTurns), PUBLIC_URL: 'http://test.invalid' }), ...LIMITS, ...config };
  const app = createApp({ secrets: loadSecrets({}), log, clock: { sleep: async () => {} }, file, ...overrides, config: cfg });
  t.after(() => { app.close(); if (app.server.closeAllConnections) app.server.closeAllConnections(); });
  return { app, domain: app.domain, out, file, dir };
}

// ---------- D12: the per-room budget, through the real proxy ----------

// A built-in room on the real proxy; `answers` are the fetch replies in order (a function is called, anything else returned).
function budgetRoom(t, answers, opts = {}) {
  const calls = [];
  const queue = answers.slice();
  const fetch = async (url, init) => { calls.push(JSON.parse(init.body)); const next = queue.shift(); return typeof next === 'function' ? next() : next; };
  const b = boot(t, { ...opts, overrides: { secrets: loadSecrets({ ANTHROPIC_API_KEY: 'sk-ant-LIMITS-1' }), fetch, ...opts.overrides } });
  const room = b.domain.createLiveRoom('1.2.3.4', { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'builtin', modeB: 'builtin' });
  return { ...b, room, calls, queue };
}
const sealBoth = (domain, room) => { domain.sealCard(room, 'A', CARD('Ann'), 'test'); domain.sealCard(room, 'B', CARD('Ben'), 'test'); };

test('chargeCall: drafts are not charged, however many go through the real proxy', T, async (t) => {
  const r = budgetRoom(t, Array.from({ length: 5 }, draftCard), { maxTurns: 1 });
  for (let i = 0; i < 5; i++) await r.domain.draftCard(r.room, 'A', DRAFT);
  assert.equal(r.calls.length, 5);
  assert.ok(!r.room.apiCalls, 'no call was charged');
  r.domain.chargeCall(r.room, 'draft');
  assert.ok(!r.room.apiCalls);
});

test('chargeCall: turn and authority calls are charged and the count is saved', T, async (t) => {
  const { domain, app } = boot(t, { overrides: { proxy: fakeProxy() } });
  const room = domain.createDemoRoom();
  const saved = [];
  const save = app.store.save;
  app.store.save = (id) => { saved.push(id); return save(id); };
  domain.chargeCall(room, 'turn');
  domain.chargeCall(room, 'authority');
  assert.equal(room.apiCalls, 2);
  assert.deepEqual(saved, [room.id, room.id]);
});

test('chargeCall: a stopped domain refuses every kind, and a run cut off by stop() is not marked error', T, async (t) => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const r = budgetRoom(t, [() => gate.then(junk)]);
  sealBoth(r.domain, r.room);
  await new Promise((res) => setImmediate(res));
  assert.equal(r.calls.length, 1, 'the call is in flight');
  assert.equal(r.room.apiCalls, 1);
  r.domain.stop();
  release();
  await settle(r.room);
  assert.notEqual(r.room.status, 'error');
  assert.equal(r.room.error, null);
  assert.ok(!r.out.join('').includes('event="room.run_failed"'), 'a stop is not a failure');
  for (const kind of ['turn', 'authority', 'draft']) assert.throws(() => r.domain.chargeCall(r.room, kind), (e) => !(e instanceof BudgetError));
  assert.equal(r.room.apiCalls, 1, 'nothing billed after the stop');
  // The restart marks it paused/interrupted.
  assert.equal(r.app.store.flush(), true);
  const again = boot(t, { overrides: { proxy: fakeProxy() }, dir: r.dir });
  const room = again.domain.rooms.get(r.room.id);
  assert.equal(room.status, 'paused');
  assert.equal(room.interrupted, true);
});

test('run() and finalise log a ProxyError and a client-safe error at warn, anything else at error', T, async (t) => {
  const proxyFail = budgetRoom(t, [junk()], { maxTurns: 5 });
  sealBoth(proxyFail.domain, proxyFail.room);
  await settle(proxyFail.room);
  assert.ok(proxyFail.out.join('').includes('level=warn event="room.run_failed"'));
  assert.ok(proxyFail.out.join('').includes('level=error event="proxy.failed"'), 'the proxy itself logged at error');

  const { domain, out } = boot(t, { overrides: { proxy: fakeProxy({ live: () => true, takeTurn: async () => { throw new TypeError('bug'); } }) } });
  const room = domain.createLiveRoom('1.2.3.4', { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'builtin', modeB: 'builtin' });
  sealBoth(domain, room);
  await settle(room);
  assert.ok(out.join('').includes('level=error event="room.run_failed"'));

  const auth = boot(t, { overrides: { proxy: fakeProxy({
    live: () => true,
    takeTurn: (rm, seat) => Promise.resolve(seat === 'A' ? { message: 'm', status: 'continue', proposal: { terms: ['x'], depends_on: [] } } : { message: 'm', status: 'agree' }),
    mapAuthority: async () => { throw new BudgetError(); },
  }) } });
  const ar = auth.domain.createLiveRoom('1.2.3.4', { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'builtin', modeB: 'builtin' });
  sealBoth(auth.domain, ar);
  await settle(ar);
  assert.equal(ar.status, 'agreed', 'a refused authority call does not stop the agreement');
  assert.ok(auth.out.join('').includes('level=warn event="brief.authority_failed"'));
});

// ---------- D3: eviction ----------

function clockApp(t, opts = {}) {
  const clock = { t: START, now: () => clock.t, sleepImpl: async () => {}, sleep: (ms) => clock.sleepImpl(ms) };
  const b = boot(t, { ...opts, overrides: { proxy: fakeProxy(), ...opts.overrides, clock } });
  const events = [];
  b.domain.onChange((room, kind) => { if (kind === 'evicted') events.push(room.id); });
  const live = () => b.domain.createLiveRoom('1.2.3.4', { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'external', modeB: 'external' });
  return { ...b, clock, events, live };
}

test('evict: a live room is evicted only after the TTL since its last ledger entry, and the store drops it', T, async (t) => {
  const e = clockApp(t);
  const room = e.live();
  e.clock.t += 20 * DAY;
  e.domain.joinAsAgent(room, 'A', 'agent'); // a ledger entry: activity (pxp stamps it with the real time, so restamp it on the fake clock)
  room.ledger[room.ledger.length - 1].at = new Date(e.clock.t).toISOString();
  e.clock.t += 29 * DAY; // 49 days after creation, 29 after the last entry
  assert.equal(e.domain.evictExpired(), 0);
  assert.ok(e.domain.rooms.has(room.id));
  e.clock.t += 2 * DAY;
  assert.equal(e.domain.evictExpired(), 1);
  assert.equal(e.domain.rooms.has(room.id), false);
  assert.deepEqual(e.events, [room.id]);
  assert.ok(e.out.join('').includes(`event="room.evicted" room="${room.id}" reason="ttl"`));
  assert.equal(e.app.store.flush(), true);
  assert.equal(JSON.parse(fs.readFileSync(e.file, 'utf8')).rooms[room.id], undefined, 'gone from disk');
});

test('evict: a demo room goes after 24 hours, and the configured limits are used', T, async (t) => {
  const e = clockApp(t, { config: { demoTtlHours: 6, roomTtlDays: 2 } });
  const demo = e.domain.createDemoRoom();
  const live = e.live();
  e.clock.t += 5 * HOUR;
  assert.equal(e.domain.evictExpired(), 0);
  e.clock.t += 2 * HOUR;
  assert.equal(e.domain.evictExpired(), 1);
  assert.equal(e.domain.rooms.has(demo.id), false);
  assert.ok(e.domain.rooms.has(live.id));
  e.clock.t += 2 * DAY;
  assert.equal(e.domain.evictExpired(), 1);

  const d = clockApp(t);
  const demo24 = d.domain.createDemoRoom();
  d.clock.t += 23 * HOUR;
  assert.equal(d.domain.evictExpired(), 0);
  d.clock.t += 2 * HOUR;
  assert.equal(d.domain.evictExpired(), 1);
  assert.equal(d.domain.rooms.has(demo24.id), false);
});

test('evict: a busy room (running, or a draft in flight) is never evicted, at any age', T, async (t) => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const e = clockApp(t, { overrides: { proxy: fakeProxy({ live: () => true, draftCard: async () => { await gate; return { principal: { name: 'x' }, goal: 'g', must_haves: ['m'] }; } }) } });
  const running = e.domain.createDemoRoom();
  running.running = true;
  const drafting = e.domain.createLiveRoom('1.2.3.4', { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'builtin', modeB: 'builtin' });
  const p = e.domain.draftCard(drafting, 'A', DRAFT);
  assert.equal(e.domain.busy(drafting), true);
  e.clock.t += 1000 * DAY;
  assert.equal(e.domain.evictExpired(), 0);
  assert.ok(e.domain.rooms.has(running.id) && e.domain.rooms.has(drafting.id));
  release();
  await p;
  running.running = false;
  assert.equal(e.domain.evictExpired(), 2, 'once idle they are old enough');
});

test('evict: an unparsable timestamp is never evicted for age, and is logged once', T, async (t) => {
  const e = clockApp(t);
  const room = e.domain.createDemoRoom();
  room.createdAt = 'garbage';
  room.ledger[room.ledger.length - 1].at = 'garbage';
  e.clock.t += 1000 * DAY;
  assert.equal(e.domain.evictExpired(), 0);
  assert.equal(e.domain.evictExpired(), 0);
  assert.ok(e.domain.rooms.has(room.id));
  assert.equal(e.out.filter((l) => l.includes('event="room.timestamp_unparsable"')).length, 1);
});

test('createApp evicts at load, and the hourly sweep is a fixed one-hour interval, unref-ed, that close() clears', T, async (t) => {
  const aged = fs.readFileSync(FIXTURE, 'utf8');
  const fresh = boot(t, { content: aged, overrides: { proxy: fakeProxy(), clock: { now: () => Date.parse('2026-01-02T00:00:00Z'), sleep: async () => {} } } });
  assert.ok(fresh.domain.rooms.size >= 6, 'in date: kept');
  const stale = boot(t, { content: aged, overrides: { proxy: fakeProxy(), clock: { now: () => Date.parse('2030-01-01T00:00:00Z'), sleep: async () => {} } } });
  assert.equal(stale.domain.rooms.size, 0, 'past every TTL at load');
  assert.equal(stale.app.store.flush(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(stale.file, 'utf8')).rooms, {});

  const real = { setInterval: global.setInterval, clearInterval: global.clearInterval };
  const intervals = [];
  const cleared = [];
  global.setInterval = (fn, ms, ...rest) => {
    const h = real.setInterval(fn, ms, ...rest);
    const rec = { fn, ms, h, unref: false };
    intervals.push(rec);
    const u = h.unref.bind(h);
    h.unref = () => { rec.unref = true; return u(); };
    return h;
  };
  global.clearInterval = (h) => { cleared.push(h); return real.clearInterval(h); };
  let app;
  try {
    app = boot(t, { overrides: { proxy: fakeProxy() } }).app;
    const sweep = intervals.find((i) => i.ms === HOUR);
    assert.ok(sweep, 'an interval of exactly one hour');
    assert.equal(sweep.unref, true);
    assert.ok(intervals.every((i) => i.ms <= 2 ** 31 - 1), 'no timer longer than the Node cap');
    sweep.fn(); // the hourly tick runs evict without throwing
    app.close();
    assert.ok(cleared.includes(sweep.h), 'close() clears the sweep');
  } finally { global.setInterval = real.setInterval; global.clearInterval = real.clearInterval; }
});

test('an evicted room: the room API is 404, the static brief page is 200, and its SSE stream is ended', T, async (t) => {
  const e = clockApp(t);
  await new Promise((resolve) => e.app.listen(0, '127.0.0.1', resolve));
  const port = e.app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const room = e.domain.createDemoRoom();
  assert.equal((await fetch(`${base}/api/rooms/${room.id}`)).status, 200);
  let closed = false;
  const c = { status: null };
  c.ready = new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: `/api/rooms/${room.id}/events` }, (res) => { c.status = res.statusCode; res.resume(); res.on('close', () => { closed = true; }); resolve(); });
  });
  await c.ready;
  assert.equal(c.status, 200);
  assert.equal(closed, false);
  e.clock.t += 2 * DAY;
  assert.equal(e.domain.evictExpired(), 1);
  for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, true, 'the stream was ended');
  assert.equal((await fetch(`${base}/api/rooms/${room.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/rooms/${room.id}/events`)).status, 404);
  assert.equal((await fetch(`${base}/brief/${room.id}`)).status, 200, 'the brief page itself is static');
});

// ---------- per-IP room quota keyed by ipKey ----------

test('takeQuota: one /64 shares a per-IP quota, and an IPv4 and its IPv4-mapped form share one', T, async (t) => {
  const open = (domain, ip) => domain.createLiveRoom(ip, { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'external', modeB: 'external' });
  const tooMany = (e) => e instanceof ApiError && e.code === 429 && /maximum live rooms/.test(e.message);
  const six = boot(t, { overrides: { proxy: fakeProxy() }, config: { perIpDaily: 3, dailyRoomLimit: 100 } });
  open(six.domain, '2001:db8:1:2::1');
  open(six.domain, '2001:db8:1:2:ffff::2');
  open(six.domain, '2001:DB8:1:2:0:0:0:3');
  assert.throws(() => open(six.domain, '2001:db8:1:2:aaaa::4'), tooMany, 'a fourth address in the same /64');
  open(six.domain, '2001:db8:1:3::1'); // another /64 has its own quota

  const four = boot(t, { overrides: { proxy: fakeProxy() }, config: { perIpDaily: 2, dailyRoomLimit: 100 } });
  open(four.domain, '1.2.3.4');
  open(four.domain, '::ffff:1.2.3.4');
  assert.throws(() => open(four.domain, '1.2.3.4'), tooMany);
  assert.throws(() => open(four.domain, '::FFFF:102:304'), tooMany, 'the hex spelling of the same address');
});

// ---------- trusted-proxy rule (D5) wired through createApp ----------

const fakeReq = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });

test('clientIp: the default (private) believes X-Forwarded-For only from a loopback or private peer, and returns canonical addresses', T, async (t) => {
  const ip = boot(t, { overrides: { proxy: fakeProxy() } }).app.diagnostics.clientIp;
  for (const peer of ['203.0.113.7', '::ffff:203.0.113.7']) assert.equal(ip(fakeReq(peer, '1.2.3.4')), '203.0.113.7', peer + ' is public: its XFF is ignored');
  for (const peer of ['127.0.0.1', '10.0.0.5', '::ffff:10.0.0.5', '::1']) assert.equal(ip(fakeReq(peer, '9.9.9.9, 1.2.3.4')), '1.2.3.4', peer + ' is trusted: the last entry');
  assert.equal(ip(fakeReq('127.0.0.1')), '127.0.0.1', 'no header: the socket');
  assert.equal(ip(fakeReq('::ffff:127.0.0.1', 'garbage')), '127.0.0.1', 'an entry that is not an address falls back to the socket');
});

test('clientIp: never ignores X-Forwarded-For even from loopback, and always believes it from anyone', T, async (t) => {
  const never = boot(t, { config: { trustProxy: 'never' }, overrides: { proxy: fakeProxy() } }).app.diagnostics.clientIp;
  assert.equal(never(fakeReq('127.0.0.1', '1.2.3.4')), '127.0.0.1');
  const always = boot(t, { config: { trustProxy: 'always' }, overrides: { proxy: fakeProxy() } }).app.diagnostics.clientIp;
  assert.equal(always(fakeReq('203.0.113.7', '1.2.3.4')), '1.2.3.4');
});

test('a real request from loopback is counted under its X-Forwarded-For address (private trusts loopback)', T, async (t) => {
  const { app } = boot(t, { overrides: { proxy: fakeProxy() } });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (xff) => fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify({ topic: 'T', modeA: 'external', modeB: 'external' }) });
  assert.equal((await post('198.51.100.9')).status, 201);
  assert.equal((await post('::ffff:198.51.100.9')).status, 201);
  assert.deepEqual({ ...app.store.state.usage.byIp }, { '198.51.100.9': 2 }, 'counted under the forwarded address, in one canonical spelling');
});

// ---------- D12 (gate-2): a spent budget ends the room as stalled ----------

test('a BudgetError ends the room as stalled with a brief, no error text and no dead-end Resume', T, async (t) => {
  // maxTurns 2 -> 6 calls. Five unparseable answers (each an error room that is resumed), one good turn, then the 7th call is
  // refused before any HTTP request.
  const r = budgetRoom(t, [junk(), junk(), junk(), junk(), junk(), turn()]);
  sealBoth(r.domain, r.room);
  await settle(r.room);
  for (let i = 0; i < 4; i++) {
    assert.equal(r.room.status, 'error');
    assert.equal(r.room.error, "The AI service didn't respond.");
    r.domain.resume(r.room);
    await settle(r.room);
  }
  assert.equal(r.room.apiCalls, 5);
  r.domain.resume(r.room); // the 6th call succeeds: a turn; the 7th is over budget
  await settle(r.room);
  assert.equal(r.calls.length, 6, 'the over-budget call never reached fetch');
  assert.equal(r.room.apiCalls, 6, 'a refused call is not counted');
  assert.equal(r.room.turnCount, 1);
  assert.equal(r.room.status, 'stalled');
  assert.equal(r.room.error, null);
  assert.equal(r.room.brief.outcome, 'no_agreement');
  assert.equal(r.room.ledger.some((e) => e.type === 'turn_limit'), false, 'no new ledger type');
  assert.throws(() => r.domain.resume(r.room), (e) => e instanceof ApiError && e.code === 409, 'a stalled room has nothing to resume');
  assert.throws(() => r.domain.chargeCall(r.room, 'turn'), (e) => e instanceof BudgetError && e instanceof ApiError && e.code === 429 && e.message === SENTENCE);
  const log = r.out.join('');
  assert.ok(!log.includes('level=error event="room.run_failed"'), 'a budget refusal is an expected failure');
  assert.ok(log.includes('level=warn event="room.run_failed"'));
});

test('any failure of the call that spends the last of the budget also ends the room as stalled', T, async (t) => {
  const r = budgetRoom(t, [junk(), junk(), junk(), junk(), junk(), junk()]);
  sealBoth(r.domain, r.room);
  await settle(r.room);
  for (let i = 0; i < 5; i++) { r.domain.resume(r.room); await settle(r.room); }
  assert.equal(r.calls.length, 6);
  assert.equal(r.room.status, 'stalled', 'the 6th failure spent the budget: nothing left to resume');
  assert.equal(r.room.error, null);
  assert.ok(r.room.brief);
});

// A sealed external live room, made ready for the budget cases by hand.
function spentRoom(domain, status, apiCalls) {
  const room = domain.createLiveRoom('1.2.3.4', { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'external', modeB: 'external' });
  sealBoth(domain, room);
  room.status = status;
  room.waitingOn = null;
  room.apiCalls = apiCalls;
  return room;
}

test('resume on a room whose budget is spent stalls it and returns normally, for error and paused alike', T, async (t) => {
  const { domain, app } = boot(t, { overrides: { proxy: fakeProxy() } });
  for (const status of ['error', 'paused']) {
    const room = spentRoom(domain, status, 6);
    room.error = status === 'error' ? "The AI service didn't respond." : null;
    const versions = room.version;
    assert.equal(domain.resume(room), undefined);
    assert.equal(room.status, 'stalled', status);
    assert.equal(room.error, null);
    assert.ok(room.brief);
    assert.ok(room.version > versions, 'listeners and the store heard about it');
    assert.equal(room.running, false);
  }
  const fresh = spentRoom(domain, 'error', 5);
  const run = domain.resume(fresh); // budget left: a normal resume (an external seat, so it waits)
  assert.equal(run, undefined);
  assert.notEqual(fresh.status, 'stalled');
  assert.ok(app);
});

test('hydrate stalls an error or paused room whose budget is spent, and leaves the others', T, async (t) => {
  const first = boot(t, { overrides: { proxy: fakeProxy() } });
  const a = spentRoom(first.domain, 'error', 6);
  const b = spentRoom(first.domain, 'paused', 6);
  const c = spentRoom(first.domain, 'error', 5);
  c.error = "The AI service didn't respond.";
  assert.equal(first.app.store.flush(), true);
  const again = boot(t, { overrides: { proxy: fakeProxy() }, dir: first.dir });
  for (const id of [a.id, b.id]) {
    const room = again.domain.rooms.get(id);
    assert.equal(room.status, 'stalled');
    assert.equal(room.error, null);
    assert.ok(room.brief);
  }
  assert.equal(again.domain.rooms.get(c.id).status, 'error', 'budget left: still resumable');
  assert.equal(again.domain.rooms.get(c.id).error, "The AI service didn't respond.");
});

test('the budget fails closed: a damaged maxTurns or apiCalls cannot lift the cap', T, async (t) => {
  const { domain } = boot(t, { overrides: { proxy: fakeProxy() } }); // config maxTurns is 2 -> cap 6
  const demoRoom = () => domain.createDemoRoom();
  for (const bad of [undefined, null, Infinity, NaN, 'x', '5', -3, 0, 1.5]) {
    const room = demoRoom();
    room.maxTurns = bad;
    room.apiCalls = 5;
    domain.chargeCall(room, 'turn'); // 6th call of a cap of 6
    assert.equal(room.apiCalls, 6, String(bad));
    assert.throws(() => domain.chargeCall(room, 'turn'), BudgetError, 'maxTurns ' + String(bad));
  }
  for (const bad of ['5', NaN, Infinity, -1, {}, [], true]) {
    const room = demoRoom();
    room.apiCalls = bad;
    assert.throws(() => domain.chargeCall(room, 'turn'), BudgetError, 'apiCalls ' + JSON.stringify(bad));
    assert.equal(room.apiCalls, bad, 'a refused call changes nothing');
  }
  const room = demoRoom();
  room.maxTurns = 10; // a sound maxTurns is used as it is
  room.apiCalls = 29;
  domain.chargeCall(room, 'turn');
  assert.throws(() => domain.chargeCall(room, 'turn'), BudgetError);
});

test('hydrate: a legacy room.error that is not a fixed sentence becomes the generic one, and the budget sentence is no longer a stored error', T, async (t) => {
  const first = boot(t, { overrides: { proxy: fakeProxy() } });
  const a = spentRoom(first.domain, 'error', 3);
  a.error = SENTENCE;
  assert.equal(first.app.store.flush(), true);
  const again = boot(t, { overrides: { proxy: fakeProxy() }, dir: first.dir });
  assert.equal(again.domain.rooms.get(a.id).error, 'Something went wrong in this room.');
});

// ---------- D3 (gate-2): the hard room cap ----------

// maxRooms 20 -> evicts down to 19 once it is passed.
function capacityApp(t, maxRooms, opts = {}) {
  const e = clockApp(t, { ...opts, config: { maxRooms, perIpDaily: 100, dailyRoomLimit: 100, ...opts.config } });
  const order = [];
  e.domain.onChange((room, kind) => { if (kind === 'evicted') order.push(room); });
  return { ...e, order };
}
const liveRoomIn = (domain, status) => {
  const room = domain.createLiveRoom('1.2.3.4', { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'external', modeB: 'external' });
  room.status = status;
  return room;
};

test('capacity: flooding 1.2 x maxRooms demo creates never lets rooms.size pass maxRooms', T, async (t) => {
  const e = capacityApp(t, 50);
  let peak = 0;
  for (let i = 0; i < 60; i++) { e.domain.createDemoRoom(); e.clock.t += 1000; peak = Math.max(peak, e.domain.rooms.size); }
  assert.ok(peak <= 50, 'peak ' + peak);
  assert.ok(e.order.length >= 10, 'rooms were evicted to make space');
  assert.ok(e.out.join('').includes('reason="capacity"'));
});

test('capacity: a real user\'s older paused demo survives while untouched flood rooms exist', T, async (t) => {
  const e = capacityApp(t, 20);
  const mine = e.domain.createDemoRoom();
  e.domain.sealCard(mine, 'A', mine.seats.A.card, 'web'); // touched: a seat is sealed and the ledger has grown
  mine.status = 'paused';
  e.clock.t += 1000;
  for (let i = 0; i < 40; i++) { e.domain.createDemoRoom(); e.clock.t += 1000; }
  assert.ok(e.domain.rooms.has(mine.id), 'still there, though it is the oldest room');
  assert.ok(e.domain.rooms.size <= 20);
});

test('capacity: a finished demo goes before one still in progress, a running demo before any live room, and its loop stops', T, async (t) => {
  const e = capacityApp(t, 3);
  const live = liveRoomIn(e.domain, 'agreed');
  e.clock.t += 1000;
  const gate = new Promise((res) => { e.release = res; });
  e.clock.sleepImpl = () => gate;
  const running = e.domain.createDemoRoom();
  e.domain.sealCard(running, 'A', running.seats.A.card, 'web');
  e.domain.sealCard(running, 'B', running.seats.B.card, 'web');
  assert.equal(running.running, true);
  const scriptLength = running.script.length;
  e.clock.t += 1000;
  const finished = e.domain.createDemoRoom();
  finished.status = 'agreed';
  e.clock.t += 1000;
  const untouched = e.domain.createDemoRoom(); // 4 rooms > 3: down to 2, never the room being created
  assert.deepEqual(e.order.map((r) => r.id), [finished.id, running.id], 'finished demo first, then the running one');
  assert.ok(e.domain.rooms.has(live.id), 'the live room outlives every demo');
  assert.ok(e.domain.rooms.has(untouched.id));
  e.release();
  await settle(running);
  assert.equal(running.turnCount, 0, 'the loop took no turn for an evicted room');
  assert.equal(running.script.length, scriptLength);
  assert.equal(e.domain.rooms.has(running.id), false);
});

test('capacity: a live agreed room goes only after every demo, and a resumable live room never does', T, async (t) => {
  const a = capacityApp(t, 2);
  const live = liveRoomIn(a.domain, 'agreed');
  const demo1 = a.domain.createDemoRoom();
  a.clock.t += 1000;
  a.domain.createDemoRoom(); // 3 > 2: down to 1
  assert.deepEqual(a.order.map((r) => r.id), [demo1.id, live.id], 'the demo, then the live room');

  const b = capacityApp(t, 20);
  const protectedRooms = [liveRoomIn(b.domain, 'error'), liveRoomIn(b.domain, 'paused'), liveRoomIn(b.domain, 'drafting'), liveRoomIn(b.domain, 'negotiating')];
  const busy = liveRoomIn(b.domain, 'agreed');
  busy.running = true;
  protectedRooms.push(busy);
  for (let i = 0; i < 40; i++) { b.domain.createDemoRoom(); b.clock.t += 1000; }
  for (const r of protectedRooms) assert.ok(b.domain.rooms.has(r.id), r.status);
  assert.ok(b.domain.rooms.size <= 20);

  const c = capacityApp(t, 1);
  const keep = liveRoomIn(c.domain, 'error'); // budget left: resumable
  c.domain.createDemoRoom();
  c.domain.createDemoRoom();
  assert.ok(c.domain.rooms.has(keep.id));
  const full = capacityApp(t, 1);
  liveRoomIn(full.domain, 'paused');
  liveRoomIn(full.domain, 'paused');
  assert.ok(full.out.join('').includes('level=warn event="rooms.over_capacity"'), 'nothing could be evicted: warned, and went on');
  assert.equal(full.domain.rooms.size, 2);
});

test('capacity: a live error room whose budget is spent is the last to go', T, async (t) => {
  const e = capacityApp(t, 2);
  const spent = liveRoomIn(e.domain, 'error');
  spent.apiCalls = 6;
  e.domain.createDemoRoom();
  e.domain.createDemoRoom();
  assert.equal(e.domain.rooms.has(spent.id), false);
});

// ---------- D3 (gate-2): a seat action whose room was evicted while its body arrived ----------

test('a seat action for a room evicted while the body was still arriving is a 404', T, async (t) => {
  const e = clockApp(t);
  await new Promise((resolve) => e.app.listen(0, '127.0.0.1', resolve));
  const port = e.app.server.address().port;
  const room = e.domain.createDemoRoom();
  const token = room.seats.A.token;
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/rooms/${room.id}/seats/A/seal`, headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('{"token":');
    setTimeout(() => {
      e.clock.t += 2 * DAY;
      assert.equal(e.domain.evictExpired(), 1);
      req.end(JSON.stringify(token) + '}');
    }, 100);
  });
  assert.equal(status, 404);
  assert.equal(room.seats.A.sealed, false, 'nothing was done to the evicted room');
});

test('log: reason accepts only ttl and capacity', T, async () => {
  const out = [];
  const log = createLog({ stream: { write: (s) => out.push(s) } });
  log.info('x', { reason: 'ttl' });
  log.info('x', { reason: 'capacity' });
  log.info('x', { reason: 'user said this' });
  assert.ok(out[0].includes('reason="ttl"') && out[1].includes('reason="capacity"'));
  assert.ok(!out[2].includes('reason'));
});

// ---------- gaps filled by the dedicated test pass ----------

test('capacity: eviction goes down to the 95% margin, not just under the cap', T, async (t) => {
  const e = capacityApp(t, 100);
  for (let i = 0; i < 100; i++) { e.domain.createDemoRoom(); e.clock.t += 1000; }
  assert.equal(e.domain.rooms.size, 100, 'at the cap: nothing evicted yet');
  assert.equal(e.order.length, 0);
  e.domain.createDemoRoom(); // 101 > 100: down to 95
  assert.equal(e.domain.rooms.size, 95);
  assert.equal(e.order.length, 6);
});

test('capacity: over_capacity is warned once per episode, and again after the room count recovers', T, async (t) => {
  const e = capacityApp(t, 1);
  const count = () => (e.out.join('').match(/event="rooms\.over_capacity"/g) || []).length;
  const a = liveRoomIn(e.domain, 'paused');
  liveRoomIn(e.domain, 'paused');
  assert.equal(count(), 1);
  liveRoomIn(e.domain, 'paused');
  e.domain.enforceCapacity();
  assert.equal(count(), 1, 'still over capacity: not warned again');
  for (const r of [...e.domain.rooms.values()]) if (r !== a) e.domain.rooms.delete(r.id);
  e.domain.enforceCapacity(); // back within the cap: the episode ends
  liveRoomIn(e.domain, 'paused');
  assert.equal(count(), 2, 'a new episode warns again');
});

// ---------- MCP wording for a room stalled by the AI allowance ----------

test('MCP next_action: a stalled room that stopped before its turn limit says the AI allowance is spent; at the limit it says so', T, async (t) => {
  const mcp = require('../lib/mcp');
  const { domain, app } = boot(t, { overrides: { proxy: fakeProxy() } });
  const nextAction = async (room) => {
    let body = '';
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_room', arguments: { link: app.ops.seatLink(room, 'A') } } };
    await mcp.handle({ method: 'POST', headers: {}, socket: { remoteAddress: '1.2.3.4' } }, { writeHead() {}, end: (b) => { body = b || ''; } }, app.ops, { readBody: async () => rpc, clientIp: () => '1.2.3.4' });
    return JSON.parse(JSON.parse(body).result.content[0].text).next_action;
  };
  const room = spentRoom(domain, 'paused', 6);
  domain.resume(room); // spent: ends as stalled with turnCount 0 < maxTurns 2
  assert.equal(room.status, 'stalled');
  assert.equal(await nextAction(room), 'No agreement: the room used up its AI allowance. Call get_brief and report to your principal.');
  room.turnCount = room.maxTurns;
  assert.equal(await nextAction(room), 'No agreement within the turn limit. Call get_brief and report to your principal.');
});

// ---------- pins for the eviction and logging rules ----------

// Ledger entries carry the real time, so a test that depends on age stamps its rooms by hand.
const stampAt = (room, ms) => { room.ledger[room.ledger.length - 1].at = new Date(ms).toISOString(); };

test('capacity: within a tier the oldest room goes first', T, async (t) => {
  const e = capacityApp(t, 3);
  const made = [];
  for (let i = 0; i < 4; i++) { const r = e.domain.createDemoRoom(); stampAt(r, START + i * 1000); made.push(r); }
  assert.deepEqual(e.order.map((r) => r.id), [made[0].id, made[1].id], 'the 4th pushed it to 4: down to 2, oldest first');
  assert.deepEqual([...e.domain.rooms.keys()].sort(), [made[2].id, made[3].id].sort());
});

test('capacity: the tiers, in order: untouched demo, finished demo, any other demo, live stalled, live error with the budget spent', T, async (t) => {
  const pxp = require('../lib/pxp');
  // Built in a roomy app (no eviction on the way), then handed to an app whose cap is 1 (down to 0: everything evictable goes).
  const src = capacityApp(t, 100);
  let n = 0;
  const stamp = (r) => { stampAt(r, START + (n++) * 1000); return r; }; // each room newer than the one before it
  const spent = stamp(liveRoomIn(src.domain, 'error')); spent.apiCalls = 6;                        // tier 4 (oldest)
  const stalled = stamp(liveRoomIn(src.domain, 'stalled'));                                        // tier 3
  const touched = src.domain.createDemoRoom();                                                     // tier 2: a seat is sealed
  src.domain.sealCard(touched, 'A', touched.seats.A.card, 'web'); touched.status = 'paused'; stamp(touched);
  const twoEntries = src.domain.createDemoRoom();                                                  // tier 2: not untouched
  pxp.appendLedger(twoEntries, 'agent_joined', { seat: 'A', agent: 'x' }); stamp(twoEntries);
  const finished = src.domain.createDemoRoom(); finished.status = 'agreed'; pxp.appendLedger(finished, 'agreement', {}); stamp(finished); // tier 1
  const untouched = stamp(src.domain.createDemoRoom());                                            // tier 0 (newest)
  const e = capacityApp(t, 1);
  for (const r of [spent, stalled, touched, twoEntries, finished, untouched]) e.domain.rooms.set(r.id, r);
  assert.equal(e.domain.enforceCapacity(), 6);
  const names = new Map([[spent.id, 'spent'], [stalled.id, 'stalled'], [touched.id, 'touched'], [twoEntries.id, 'two'], [finished.id, 'finished'], [untouched.id, 'untouched']]);
  assert.deepEqual(e.order.map((r) => names.get(r.id)), ['untouched', 'finished', 'touched', 'two', 'stalled', 'spent']);
});

test('logFailure: a 503 ApiError logs room.run_failed at warn, any other ApiError at error', T, async (t) => {
  const { ApiError } = require('../lib/errors');
  for (const [code, level] of [[503, 'warn'], [409, 'error'], [429, 'error']]) {
    const { domain, out } = boot(t, { overrides: { proxy: fakeProxy({ live: () => true, takeTurn: async () => { throw new ApiError(code, 'x'); } }) } });
    const room = domain.createLiveRoom('1.2.3.4', { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'builtin', modeB: 'builtin' });
    sealBoth(domain, room);
    await settle(room);
    assert.ok(out.join('').includes(`level=${level} event="room.run_failed"`), `${code} -> ${level}: ${out.join('')}`);
  }
});

test('the hourly sweep also enforces the room cap', T, async (t) => {
  const real = { setInterval: global.setInterval };
  const ticks = [];
  global.setInterval = (fn, ms, ...rest) => { ticks.push({ fn, ms }); return real.setInterval(fn, ms, ...rest); };
  let e;
  try { e = clockApp(t, { config: { maxRooms: 5 } }); } finally { global.setInterval = real.setInterval; }
  const tick = ticks.find((x) => x.ms === HOUR).fn;
  const first = e.domain.createDemoRoom();
  for (let i = 0; i < 7; i++) e.domain.rooms.set('extra' + i, { ...first, id: 'extra' + i }); // past the cap without createRoom
  assert.equal(e.domain.rooms.size, 8);
  tick();
  assert.ok(e.domain.rooms.size <= 5, 'size ' + e.domain.rooms.size);
});

test('the TTL is strict: a room exactly at it stays, one millisecond past it goes', T, async (t) => {
  const e = clockApp(t);
  const demo = e.domain.createDemoRoom();
  const live = e.live();
  for (const r of [demo, live]) r.ledger[r.ledger.length - 1].at = new Date(START).toISOString();
  e.clock.t = START + 24 * HOUR;
  assert.equal(e.domain.evictExpired(), 0, 'a demo exactly 24 hours old');
  e.clock.t = START + 24 * HOUR + 1;
  assert.equal(e.domain.evictExpired(), 1);
  assert.equal(e.domain.rooms.has(demo.id), false);
  e.clock.t = START + 30 * DAY;
  assert.equal(e.domain.evictExpired(), 0, 'a live room exactly 30 days old');
  e.clock.t = START + 30 * DAY + 1;
  assert.equal(e.domain.evictExpired(), 1);
});

test('the trusted-proxy rule is built once: many requests from a public peer with X-Forwarded-For give one warning', T, async (t) => {
  const { app, out } = boot(t, { overrides: { proxy: fakeProxy() } });
  for (let i = 0; i < 6; i++) app.diagnostics.clientIp(fakeReq('203.0.113.7', '1.2.3.4'));
  assert.equal(out.filter((l) => l.includes('event="net.xff_ignored"')).length, 1);
});
