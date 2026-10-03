'use strict';
// lib/rooms, lib/view and lib/app in-process: createApp with a temp data file, a fake proxy that plays scripted
// turns, a no-op sleep and a real logger writing to a buffer. Invariants only: statuses, codes, log events.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { loadConfig, loadSecrets } = require('../lib/config');
const { createLog } = require('../lib/log');
const { StoreError } = require('../lib/store');
const demo = require('../lib/demo');
const mcp = require('../lib/mcp');
const { ROOT } = require('../test-support/paths');
const { mkTmp, rmTmp } = require('../test-support/server');

const FIXTURE = path.join(ROOT, 'test-support', 'fixtures', 'rooms.v0.json');
const T = { timeout: 20000 };
const CARD = (name) => ({ principal: { name, role: 'tester' }, goal: 'a goal', must_haves: ['a must-have'] });
const raw = (o) => Object.assign({ message: 'm', status: 'continue' }, o);
const CONTINUE = raw({});
const PROPOSE = raw({ proposal: { terms: ['the term'], depends_on: [] } });
const AGREE = raw({ status: 'agree' });
const ESCALATE = raw({ status: 'escalate', escalation: { question: 'May we go higher?', reason: 'r' } });

// A proxy that plays `turns` in order: a raw object is returned, an Error is thrown.
function fakeProxy(turns, extra) {
  const queue = turns.slice();
  return Object.assign({
    live: () => true,
    takeTurn: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    draftCard: async () => ({ principal: { name: 'x' }, goal: 'g', must_haves: ['m'] }),
    mapAuthority: async (room, terms) => terms.map((t) => ({ term: t, A: 'must_haves', B: 'must_haves', note: 'n' })),
    MODEL: 'fake',
    queue,
  }, extra);
}

function setup(t, { turns = [], maxTurns = 10, proxy, content, overrides } = {}) {
  const dir = mkTmp('rooms-');
  t.after(() => rmTmp(dir));
  const file = path.join(dir, 'data', 'rooms.json');
  if (content !== undefined) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  const out = [];
  const log = createLog({ stream: { write: (s) => out.push(s) } });
  const config = loadConfig({ DROP_DATA_DIR: path.join(dir, 'data'), MAX_TURNS: String(maxTurns), PUBLIC_URL: 'http://test.invalid' });
  const p = proxy || fakeProxy(turns);
  const app = createApp(Object.assign({ config, secrets: loadSecrets({}), log, proxy: p, clock: { sleep: async () => {} }, file }, overrides));
  t.after(() => app.close());
  return { app, domain: app.domain, proxy: p, out, file, dir };
}

// run() is async: let it settle. With the no-op sleep every step is a microtask, so a few turns of the loop do it.
async function settle(room) {
  for (let i = 0; i < 200 && room.running; i++) await new Promise((r) => setImmediate(r));
  assert.equal(room.running, false, 'the run settled');
}

function liveRoom(domain, modes = {}) {
  return domain.createLiveRoom('1.2.3.4', Object.assign({ topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'builtin', modeB: 'builtin' }, modes));
}

function sealBoth(domain, room) {
  domain.sealCard(room, 'A', CARD('Ann'), 'test');
  domain.sealCard(room, 'B', CARD('Ben'), 'test');
}

test('built-in against built-in runs to agreement with a brief and a valid ledger', T, async (t) => {
  const { domain, app } = setup(t, { turns: [PROPOSE, AGREE] });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'agreed');
  assert.equal(room.brief.outcome, 'agreed');
  assert.deepEqual(room.brief.agreement.terms, ['the term']);
  assert.ok(Array.isArray(room.brief.authority), 'authority came from mapAuthority');
  assert.equal(app.view(room, 'A', room.seats.A.token).ledgerCheck.ok, true);
});

test('the second seal flips the status to negotiating before sealCard returns', T, async (t) => {
  const { domain } = setup(t, { turns: [PROPOSE, AGREE] });
  const room = liveRoom(domain);
  domain.sealCard(room, 'A', CARD('Ann'), 'test');
  assert.equal(room.status, 'drafting');
  domain.sealCard(room, 'B', CARD('Ben'), 'test');
  assert.equal(room.status, 'negotiating', 'run() was not deferred');
  assert.equal(room.running, true);
  await settle(room);
  assert.equal(room.status, 'agreed');
});

test('an escalation pauses the room, and the answer continues it to agreement', T, async (t) => {
  const { domain } = setup(t, { turns: [ESCALATE, PROPOSE, AGREE] });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'paused');
  assert.equal(room.pending.seat, 'A');
  assert.throws(() => domain.answerEscalation(room, 'B', 'x', 'test'), (e) => e instanceof domain.ApiError && e.code === 409);
  assert.throws(() => domain.answerEscalation(room, 'A', '   ', 'test'), (e) => e.code === 400);
  domain.answerEscalation(room, 'A', 'Yes, up to the limit.', 'test');
  assert.equal(room.status, 'negotiating', 'the answer re-enters run() synchronously');
  await settle(room);
  assert.equal(room.status, 'agreed');
  assert.equal(room.seats.A.card.amendments.length, 1);
  assert.equal(room.brief.escalations.length, 1);
});

test('hitting maxTurns stalls the room with a brief', T, async (t) => {
  const { domain } = setup(t, { turns: [CONTINUE, CONTINUE, CONTINUE], maxTurns: 2 });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'stalled');
  assert.equal(room.brief.outcome, 'no_agreement');
  assert.equal(room.turnCount, 2);
  assert.ok(room.ledger.some((e) => e.type === 'turn_limit'));
});

test('a proxy that throws sends the room to error, and resume continues it', T, async (t) => {
  const { domain } = setup(t, { turns: [new Error('upstream down'), PROPOSE, AGREE] });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'error');
  assert.throws(() => domain.resume(liveRoom(domain)), (e) => e.code === 409, 'a drafting room has nothing to resume');
  domain.resume(room);
  assert.equal(room.status, 'negotiating');
  await settle(room);
  assert.equal(room.status, 'agreed');
});

test('an external seat gets the turn, and externalTurn advances it', T, async (t) => {
  const { domain } = setup(t, { turns: [AGREE] });
  const room = liveRoom(domain, { modeA: 'external' });
  domain.joinAsAgent(room, 'A', 'Test agent');
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'negotiating');
  assert.equal(room.waitingOn, 'A');
  assert.equal(room.running, false);
  const env = await domain.externalTurn(room, 'A', PROPOSE);
  assert.equal(env.from.agent, 'Test agent');
  assert.equal(room.turn, 'B');
  await settle(room);
  assert.equal(room.status, 'agreed', 'run() carried on with the built-in seat');
});

test('externalTurn out of turn is a 409', T, async (t) => {
  const { domain } = setup(t);
  const room = liveRoom(domain, { modeA: 'external' });
  domain.joinAsAgent(room, 'A', 'Test agent');
  sealBoth(domain, room);
  await settle(room);
  await assert.rejects(domain.externalTurn(room, 'B', CONTINUE), (e) => e instanceof domain.ApiError && e.code === 409 && /isn't your turn/.test(e.message));
});

test('onChange listeners hear every emit, and emit bumps the version and saves', T, async (t) => {
  const { domain, app } = setup(t, { turns: [PROPOSE, AGREE] });
  const seen = [];
  domain.onChange((r) => seen.push(r.version));
  let saved = 0;
  const save = app.store.save;
  app.store.save = (id) => { saved++; return save(id); };
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  assert.ok(seen.length >= 5);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'the version only goes up');
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(saved >= seen.length);
});

test('a throwing listener does not break the room', T, async (t) => {
  const { domain } = setup(t, { turns: [PROPOSE, AGREE] });
  domain.onChange(() => { throw new Error('listener bug'); });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'agreed');
});

test('the demo room is created pre-filled, and answerDemo picks the branch', T, async (t) => {
  const { domain } = setup(t);
  const room = domain.createDemoRoom();
  assert.equal(room.demo, true);
  assert.equal(room.seats.A.token, room.seats.B.token, 'one token drives both demo seats');
  assert.ok(room.seats.A.card && room.seats.B.card);
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'paused');
  assert.throws(() => domain.answerDemo(room, 'B', 'accept'), (e) => e.code === 409);
  const branch = Object.keys(demo.choices)[0];
  domain.answerDemo(room, room.pending.seat, branch);
  assert.equal(room.branch, branch);
  await settle(room);
  assert.equal(room.status, 'agreed');
});

// ---------- log carry-overs ----------

test('a proxy that throws logs exactly one room.run_failed line, with the room id and no message text', T, async (t) => {
  const SECRET = 'MODEL-OUTPUT-SNIPPET-' + Math.random();
  const { domain, out } = setup(t, { turns: [new Error(SECRET)] });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  const lines = out.join('').split('\n').filter((l) => /event="room\.run_failed"/.test(l));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`room="${room.id}"`));
  assert.ok(!out.join('').includes(SECRET));
});

test('a mapAuthority that throws logs brief.authority_failed, and the room still agrees with authority null', T, async (t) => {
  const SECRET = 'AUTH-OUTPUT-SNIPPET-' + Math.random();
  const proxy = fakeProxy([PROPOSE, AGREE], { mapAuthority: async () => { throw new Error(SECRET); } });
  const { domain, out } = setup(t, { proxy });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'agreed');
  assert.equal(room.brief.authority, null);
  const lines = out.join('').split('\n').filter((l) => /event="brief\.authority_failed"/.test(l));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`room="${room.id}"`));
  assert.ok(!out.join('').includes(SECRET));
});

// ---------- entry points that keep today's codes ----------

test('createLiveRoom keeps its codes: 503 without a live proxy, 403 on the passcode, 429 on the quota', T, async (t) => {
  const off = setup(t, { proxy: fakeProxy([], { live: () => false }) });
  assert.throws(() => liveRoom(off.domain), (e) => e.code === 503);
  assert.doesNotThrow(() => liveRoom(off.domain, { modeA: 'external', modeB: 'external' }));

  const dir = mkTmp('rooms-pass-');
  t.after(() => rmTmp(dir));
  const gated = createApp({
    config: loadConfig({ DROP_DATA_DIR: dir, PER_IP_DAILY: '1' }), secrets: loadSecrets({ ROOM_PASSCODE: 'open' }),
    log: createLog({ stream: { write() {} } }), proxy: fakeProxy([]), clock: { sleep: async () => {} },
  });
  t.after(() => gated.close());
  assert.equal(gated.ops.passcodeRequired(), true);
  assert.throws(() => liveRoom(gated.domain, { passcode: 'nope' }), (e) => e.code === 403);
  assert.doesNotThrow(() => liveRoom(gated.domain, { passcode: 'open' }));
  assert.throws(() => liveRoom(gated.domain, { passcode: 'open' }), (e) => e.code === 429);
});

test('draftCard throws ApiError with the route codes in today\'s order', T, async (t) => {
  const { domain } = setup(t);
  const room = liveRoom(domain);
  const codeOn = (d) => async (body, r) => { try { await d.draftCard(r, 'A', body); return 200; } catch (e) { assert.ok(e instanceof d.ApiError); return e.code; } };
  const code = (body, r = room) => codeOn(domain)(body, r);
  assert.equal(await code({}), 400, 'no text');
  assert.equal(await code({ text: 'hello', name: 'Ann' }), 200);
  assert.ok(room.seats.A.card);
  assert.equal(await code({ text: 'hello', name: 'Ann' }, domain.createDemoRoom()), 400, 'demo cards are pre-filled');
  for (let i = 0; i < 4; i++) assert.equal(await code({ text: 'hello', name: 'Ann' }), 200);
  assert.equal(await code({ text: 'hello', name: 'Ann' }), 429, 'the sixth draft is refused');
  const failing = setup(t, { proxy: fakeProxy([], { draftCard: async () => { throw new Error('nope'); } }) });
  const fr = liveRoom(failing.domain);
  assert.equal(await codeOn(failing.domain)({ text: 'hello', name: 'Ann' }, fr), 502);
  fr.seats.A.sealed = true;
  assert.equal(await codeOn(failing.domain)({ text: 'hello', name: 'Ann' }, fr), 409, 'sealed is checked first');
});

// ---------- hydrate, createApp, close ----------

test('hydrate applies the restart rules to a loaded store', T, async (t) => {
  const { domain } = setup(t, { content: fs.readFileSync(FIXTURE, 'utf8') });
  const rooms = domain.rooms;
  assert.ok(rooms.size >= 6);
  for (const r of rooms.values()) { assert.equal(r.running, false); assert.equal(r.thinking === null || r.thinking === undefined, true); }
  assert.equal(rooms.get('interr001').status, 'paused');
  assert.equal(rooms.get('interr001').interrupted, true);
  assert.equal(rooms.get('waiting001').status, 'negotiating', 'an external seat is simply still waiting');
  assert.equal(rooms.get('waiting001').waitingOn, 'A');
  assert.equal(rooms.get('paused0001').status, 'paused');
  assert.equal(rooms.get('nomode01').status, 'drafting');
  assert.equal(rooms.get('nomode01').seats.A.mode, 'builtin');
});

test('createApp throws StoreError for a future-schema file and never exits', T, async (t) => {
  const dir = mkTmp('rooms-future-');
  t.after(() => rmTmp(dir));
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ schemaVersion: 999, rooms: {} }));
  const exit = process.exit;
  let exited = false;
  process.exit = () => { exited = true; };
  try {
    assert.throws(
      () => createApp({ config: loadConfig({ DROP_DATA_DIR: dir }), secrets: loadSecrets({}), log: createLog({ stream: { write() {} } }), proxy: fakeProxy([]) }),
      (e) => e instanceof StoreError && e.code === 'EFUTURESCHEMA',
    );
  } finally { process.exit = exit; }
  assert.equal(exited, false);
});

test('createApp builds ops with the frozen members and the same sync convention', T, async (t) => {
  const { app } = setup(t);
  const { ops } = app;
  for (const k of ['rooms', 'PUBLIC_URL', 'MAX_TURNS', 'ApiError', 'other', 'view', 'seatLink', 'authSeat', 'createLiveRoom', 'sealCard', 'joinAsAgent', 'answerEscalation', 'externalTurn', 'resume', 'live', 'passcodeRequired', 'log']) {
    assert.ok(k in ops, k);
  }
  assert.ok(ops.rooms instanceof Map);
  assert.equal(ops.PUBLIC_URL, 'http://test.invalid');
  assert.equal(ops.live(), true);
  const room = liveRoom(app.domain);
  const v = ops.view(room, 'A', room.seats.A.token);
  assert.equal(v.seat, 'A');
  assert.equal(v.live, true);
  assert.equal(v.mcpUrl, 'http://test.invalid/mcp');
  assert.equal(ops.view(room, 'A', 'wrong').seat, null);
  assert.equal(ops.seatLink(room, 'B'), `http://test.invalid/room/${room.id}?seat=B&t=${room.seats.B.token}`);
});

test('mcp logs a tool that throws a non-ApiError as mcp.tool_failed through the injected log', T, async (t) => {
  const { app, out } = setup(t);
  const ops = Object.assign({}, app.ops, { createLiveRoom() { throw new TypeError('tool bug with a secret'); } });
  const req = { method: 'POST', headers: {}, socket: { remoteAddress: '1.2.3.4' } };
  let status = null; let body = '';
  const res = { writeHead: (c) => { status = c; }, end: (b) => { body = b || ''; } };
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_room', arguments: {} } };
  await mcp.handle(req, res, ops, { readBody: async () => rpc, clientIp: () => '1.2.3.4' });
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).result.isError, true);
  assert.equal(JSON.parse(body).result.content[0].text, 'Server error');
  const lines = out.join('').split('\n').filter((l) => /event="mcp\.tool_failed"/.test(l));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('errorClass="TypeError"'));
  assert.ok(!out.join('').includes('a secret'));
});

test('close() leaves no pending timers', T, async (t) => {
  const { app } = setup(t, { turns: [PROPOSE, AGREE] });
  const room = liveRoom(app.domain);
  sealBoth(app.domain, room);
  await settle(room);
  app.close();
  if (typeof process.getActiveResourcesInfo === 'function') {
    assert.equal(process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length, 0);
  }
});

// ---------- ops convention ----------

test('ops has exactly the frozen members', T, async (t) => {
  const { app } = setup(t);
  assert.deepEqual(Object.keys(app.ops).sort(), [
    'ApiError', 'MAX_TURNS', 'PUBLIC_URL', 'answerEscalation', 'authSeat', 'createLiveRoom', 'externalTurn', 'joinAsAgent',
    'live', 'log', 'other', 'passcodeRequired', 'resume', 'rooms', 'sealCard', 'seatLink', 'view',
  ]);
  assert.equal(app.ops.rooms, app.domain.rooms);
});

test('every ops member is synchronous except externalTurn', T, async (t) => {
  const { app } = setup(t, { turns: [CONTINUE] });
  const { ops } = app;
  const thenable = (v) => Boolean(v) && typeof v.then === 'function';
  const room = ops.createLiveRoom('1.2.3.4', { topic: 'T', modeA: 'external', modeB: 'external' });
  const demoRoom = app.domain.createDemoRoom();
  // each of these throws an ApiError at once: an async member would return a rejected promise instead
  const refusals = [
    () => ops.sealCard(room, 'A', {}, 'test'),
    () => ops.joinAsAgent(demoRoom, 'A', 'agent'),
    () => ops.answerEscalation(room, 'A', 'x', 'test'),
    () => ops.resume(room),
  ];
  for (const f of refusals) assert.throws(f, (e) => e instanceof ops.ApiError && !thenable(e));
  assert.equal(thenable(ops.joinAsAgent(room, 'A', 'agent')), false);
  assert.equal(thenable(ops.sealCard(room, 'A', CARD('Ann'), 'test')), false);
  assert.equal(thenable(ops.view(room, 'A', 'x')), false);
  assert.equal(thenable(ops.live()), false);
  assert.equal(thenable(ops.passcodeRequired()), false);
  const p = ops.externalTurn(room, 'B', CONTINUE);
  assert.ok(p instanceof Promise);
  await assert.rejects(p, (e) => e instanceof ops.ApiError && e.code === 409);
});

// ---------- log events ----------

test('a throwing onChange listener is logged once as room.listener_failed, with no message text', T, async (t) => {
  const MARKER = 'LISTENER-MARKER-' + Math.random();
  const { domain, out } = setup(t, { turns: [PROPOSE, AGREE] });
  let thrown = false;
  domain.onChange(() => { if (!thrown) { thrown = true; throw new Error(MARKER); } });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'agreed');
  const lines = out.join('').split('\n').filter((l) => /event="room\.listener_failed"/.test(l));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`room="${room.id}"`));
  assert.ok(!out.join('').includes(MARKER));
});

test('onChange hears kind "change" and returns an unsubscribe', T, async (t) => {
  const { domain } = setup(t);
  const kinds = [];
  const off = domain.onChange((room, kind) => kinds.push(kind));
  const room = liveRoom(domain, { modeA: 'external', modeB: 'external' });
  domain.joinAsAgent(room, 'A', 'agent');
  assert.deepEqual([...new Set(kinds)], ['change']);
  const n = kinds.length;
  off();
  domain.joinAsAgent(room, 'B', 'agent');
  assert.equal(kinds.length, n);
});

test('mcp logs a failure outside a tool as mcp.dispatch_failed, with no message text', T, async (t) => {
  const MARKER = 'DISPATCH-MARKER-' + Math.random();
  const { app, out } = setup(t);
  let reads = 0;
  const msg = { jsonrpc: '2.0', id: 1, get method() { if (++reads === 3) throw new Error(MARKER); return 'ping'; } }; // reads: find, type check, switch
  const req = { method: 'POST', headers: {}, socket: { remoteAddress: '1.2.3.4' } };
  let body = '';
  const res = { writeHead() {}, end: (b) => { body = b || ''; } };
  await mcp.handle(req, res, app.ops, { readBody: async () => msg, clientIp: () => '1.2.3.4' });
  assert.equal(JSON.parse(body).error.code, -32603);
  const lines = out.join('').split('\n').filter((l) => /event="mcp\.dispatch_failed"/.test(l));
  assert.equal(lines.length, 1);
  assert.ok(!out.join('').includes(MARKER));
});

// ---------- stop ----------

test('close() stops a running demo from taking further turns', T, async (t) => {
  const dir = mkTmp('rooms-stop-');
  t.after(() => rmTmp(dir));
  const app = createApp({
    config: loadConfig({ DROP_DATA_DIR: dir }), secrets: loadSecrets({}), log: createLog({ stream: { write() {} } }),
    proxy: fakeProxy([]), clock: { sleep: (ms) => new Promise((r) => setTimeout(r, 25)) },
  });
  const room = app.domain.createDemoRoom();
  sealBoth(app.domain, room);
  for (let i = 0; i < 200 && room.turnCount < 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(room.turnCount >= 1, 'the demo was playing');
  app.close();
  await new Promise((r) => setTimeout(r, 80)); // the turn in flight ends
  const frozen = room.turnCount;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(room.turnCount, frozen, 'no turn after close()');
  assert.equal(room.running, false);
  assert.notEqual(room.status, 'agreed');
});

test('the clock seam supplies the dates', T, async (t) => {
  const { domain } = setup(t, { overrides: { clock: { now: () => Date.parse('2031-02-03T04:05:06.000Z'), sleep: async () => {} } } });
  const room = liveRoom(domain);
  assert.equal(room.createdAt, '2031-02-03T04:05:06.000Z');
});

// ---------- createApp overrides and wiring ----------

test('createApp deletes ROOM_PASSCODE from process.env only when it loaded the secrets itself', T, async (t) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'ROOM_PASSCODE');
  const saved = process.env.ROOM_PASSCODE;
  t.after(() => { if (had) process.env.ROOM_PASSCODE = saved; else delete process.env.ROOM_PASSCODE; });
  const dir = mkTmp('rooms-env-');
  t.after(() => rmTmp(dir));
  const base = () => ({ config: loadConfig({ DROP_DATA_DIR: dir }), log: createLog({ stream: { write() {} } }), proxy: fakeProxy([]) });

  process.env.ROOM_PASSCODE = 'from-env';
  const loaded = createApp(base());
  assert.equal(loaded.ops.passcodeRequired(), true, 'the passcode was read before it was deleted');
  assert.equal('ROOM_PASSCODE' in process.env, false, 'removed from the environment');
  loaded.close();

  process.env.ROOM_PASSCODE = 'from-env';
  const overridden = createApp(Object.assign(base(), { secrets: loadSecrets({}), file: path.join(dir, 'other.json') }));
  assert.equal(process.env.ROOM_PASSCODE, 'from-env', 'left alone when the caller supplied secrets');
  assert.equal(overridden.ops.passcodeRequired(), false);
  overridden.close();
});

test('createApp does not load an injected store, and close() closes it', T, async (t) => {
  const calls = [];
  const store = {
    state: { rooms: new Map(), usage: { day: '', total: 0, byIp: Object.create(null) } },
    load() { calls.push('load'); throw new Error('must not be called'); },
    save(id) { calls.push('save:' + id); },
    resetUsage() {},
    close() { calls.push('close'); },
  };
  const app = createApp({ config: loadConfig({}), secrets: loadSecrets({}), log: createLog({ stream: { write() {} } }), proxy: fakeProxy([]), store });
  assert.equal(app.store, store);
  assert.equal(app.domain.rooms, store.state.rooms, 'the domain works on the injected state');
  const room = app.domain.createDemoRoom();
  assert.ok(store.state.rooms.has(room.id));
  app.close();
  assert.deepEqual(calls, ['save:' + room.id, 'close']);
});

test('createApp builds its store at overrides.file, or at dataDir/rooms.json by default', T, async (t) => {
  const dir = mkTmp('rooms-file-');
  t.after(() => rmTmp(dir));
  const mk = (extra) => createApp(Object.assign({ config: loadConfig({ DROP_DATA_DIR: path.join(dir, 'd') }), secrets: loadSecrets({}), log: createLog({ stream: { write() {} } }), proxy: fakeProxy([]) }, extra));
  const custom = path.join(dir, 'elsewhere', 'custom.json');
  const a = mk({ file: custom });
  a.domain.createDemoRoom();
  a.store.flush();
  a.close();
  assert.ok(fs.existsSync(custom), 'wrote to overrides.file');
  assert.equal(fs.existsSync(path.join(dir, 'd', 'rooms.json')), false);
  const b = mk({});
  b.domain.createDemoRoom();
  b.store.flush();
  b.close();
  assert.ok(fs.existsSync(path.join(dir, 'd', 'rooms.json')), 'default file under config.dataDir');
});

test('createApp uses the injected proxy and demo', T, async (t) => {
  const stub = Object.assign({}, demo, { topic: 'Injected topic', opening: [] });
  const proxy = fakeProxy([], { live: () => false });
  const { app, domain } = setup(t, { proxy, overrides: { demo: stub } });
  assert.equal(app.proxy, proxy);
  assert.equal(app.ops.live(), false);
  assert.equal(app.view(domain.createDemoRoom(), 'A', 'x').live, false, 'view reads live from the injected proxy');
  assert.equal(domain.createDemoRoom().topic, 'Injected topic');
});

test('the domain exposes exactly its operations', T, async (t) => {
  const { domain } = setup(t);
  assert.deepEqual(Object.keys(domain).sort(), [
    'ApiError', 'answerDemo', 'answerEscalation', 'createDemoRoom', 'createLiveRoom', 'draftCard', 'externalTurn',
    'hydrate', 'joinAsAgent', 'onChange', 'other', 'resume', 'rooms', 'sealCard', 'seatLink', 'stop',
  ]);
});

test('creating a room saves once, and carries names, modes and cards', T, async (t) => {
  const { domain, app } = setup(t);
  const saves = [];
  const save = app.store.save;
  app.store.save = (id) => { saves.push(id); return save(id); };
  const live = domain.createLiveRoom('9.9.9.9', { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'external', modeB: 'builtin' });
  assert.deepEqual(saves.filter((id) => id !== undefined), [live.id], 'one per-room save');
  assert.equal(live.seats.A.name, 'Ann');
  assert.equal(live.seats.B.name, 'Ben');
  assert.equal(live.seats.A.mode, 'external');
  assert.equal(live.seats.B.mode, 'builtin');
  assert.equal(live.seats.A.card, null);
  saves.length = 0;
  const d = domain.createDemoRoom();
  assert.deepEqual(saves, [d.id]);
  assert.ok(d.seats.A.card.principal.name && d.seats.B.card.principal.name);
  assert.equal(d.ledger.length, 1);
  assert.equal(d.ledger[0].type, 'room_opened');
});

// ---------- stall ----------

test('running out of demo script stalls the room without a turn_limit entry', T, async (t) => {
  const { domain } = setup(t, { overrides: { demo: Object.assign({}, demo, { opening: [] }) } });
  const room = domain.createDemoRoom();
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'stalled');
  assert.equal(room.turnCount, 0);
  assert.equal(room.brief.outcome, 'no_agreement');
  assert.equal(room.ledger.some((e) => e.type === 'turn_limit'), false);
});

test('the turn cap clears waitingOn and records turn_limit, even when run() starts from a waiting room', T, async (t) => {
  const { domain } = setup(t, { maxTurns: 10 });
  const room = liveRoom(domain, { modeA: 'external' });
  domain.joinAsAgent(room, 'A', 'agent');
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.waitingOn, 'A');
  room.maxTurns = room.turnCount; // the cap is already reached
  room.status = 'error';
  domain.resume(room);
  await settle(room);
  assert.equal(room.status, 'stalled');
  assert.equal(room.waitingOn, null);
  const entries = room.ledger.filter((e) => e.type === 'turn_limit');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.turns, room.turnCount);
});

test('answerEscalation and answerDemo refuse when nothing is pending for the seat', T, async (t) => {
  const { domain } = setup(t);
  const room = liveRoom(domain);
  assert.throws(() => domain.answerEscalation(room, 'A', 'x', 'test'), (e) => e.code === 409 && /No question is waiting/.test(e.message));
  assert.throws(() => domain.answerDemo(room, 'A', 'accept'), (e) => e.code === 409);
});

test('an escalation answer from the wrong seat leaves the pending question in place', T, async (t) => {
  const { domain } = setup(t, { turns: [ESCALATE] });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  assert.throws(() => domain.answerEscalation(room, 'B', 'x', 'test'), (e) => e.code === 409);
  assert.equal(room.pending.seat, 'A');
});

test('a non-StoreError at startup is logged as app.init_failed and exits non-zero', T, async (t) => {
  const { makeSrc, start } = require('../test-support/server');
  const src = makeSrc({ 'lib/demo.js': "throw new TypeError('demo module is broken');\n" });
  const dir = mkTmp('init-failed-');
  t.after(() => { rmTmp(src); rmTmp(dir); });
  const r = await start(path.join(src, 'index.js'), { PORT: '0', BIND_HOST: '127.0.0.1', DROP_DATA_DIR: dir });
  assert.ok(r.exited !== undefined && r.exited !== 0, 'expected a non-zero exit\n' + r.out);
  assert.equal(r.out.split('\n').filter((l) => l.includes('app.init_failed')).length, 1, r.out);
  assert.equal(r.out.includes('store.load_failed'), false);
  await r.stop();
});
