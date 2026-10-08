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
const { emptyUsage } = require('../lib/store-core');
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

function setup(t, { turns = [], maxTurns = 10, proxy, content, overrides, limits } = {}) {
  const dir = mkTmp('rooms-');
  t.after(() => rmTmp(dir));
  const file = path.join(dir, 'data', 'rooms.json');
  if (content !== undefined) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  const out = [];
  const log = createLog({ stream: { write: (s) => out.push(s) } });
  // The fixture rooms are old on purpose: eviction is off here unless a test sets its own limits.
  const config = { ...loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: path.join(dir, 'data'), MAX_TURNS: String(maxTurns), PUBLIC_URL: 'http://test.invalid' }), roomTtlDays: 1e6, demoTtlHours: 1e9, maxRooms: 1e6, ...limits };
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
    config: loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: dir, PER_IP_DAILY: '1' }), secrets: loadSecrets({ ROOM_PASSCODE: 'open' }),
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
      () => createApp({ config: loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: dir }), secrets: loadSecrets({}), log: createLog({ stream: { write() {} } }), proxy: fakeProxy([]) }),
      (e) => e instanceof StoreError && e.code === 'EFUTURESCHEMA',
    );
  } finally { process.exit = exit; }
  assert.equal(exited, false);
});

test('createApp builds ops with the frozen members and the same sync convention', T, async (t) => {
  const { app } = setup(t);
  const { ops } = app;
  for (const k of ['rooms', 'PUBLIC_URL', 'MAX_TURNS', 'ApiError', 'other', 'view', 'seatLink', 'authSeat', 'createLiveRoom', 'sealCard', 'joinAsAgent', 'answerEscalation', 'externalTurn', 'resume', 'live', 'passcodeRequired', 'signinOn', 'userForAgentKey', 'log']) {
    assert.ok(k in ops, k);
  }
  assert.ok(ops.rooms instanceof Map);
  assert.equal(ops.PUBLIC_URL, 'http://test.invalid');
  assert.equal(ops.signinOn, false, 'a boolean, decided once by the composition root');
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
    'live', 'log', 'other', 'passcodeRequired', 'resume', 'rooms', 'sealCard', 'seatLink', 'signinOn', 'userForAgentKey', 'view',
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
    config: loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: dir }), secrets: loadSecrets({}), log: createLog({ stream: { write() {} } }),
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
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY'); // createApp also deletes the dev key
  const savedKey = process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (hadKey) process.env.ANTHROPIC_API_KEY = savedKey; else delete process.env.ANTHROPIC_API_KEY; });
  const dir = mkTmp('rooms-env-');
  t.after(() => rmTmp(dir));
  const base = () => ({ config: loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: dir }), log: createLog({ stream: { write() {} } }), proxy: fakeProxy([]) });

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
    kind: 'fake',
    state: { rooms: new Map(), usage: emptyUsage() }, // the usage the real stores start from, not hand-written fields
    load() { calls.push('load'); throw new Error('must not be called'); },
    save(id) { calls.push('save:' + id); },
    saveUsage() {},
    resetUsage() {},
    isSkipped() { return false; },
    health() { return { ok: true, failingSince: null }; },
    async drain() { return true; },
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
  const mk = (extra) => createApp(Object.assign({ config: loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: path.join(dir, 'd') }), secrets: loadSecrets({}), log: createLog({ stream: { write() {} } }), proxy: fakeProxy([]) }, extra));
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
    'ApiError', 'answerDemo', 'answerEscalation', 'busy', 'chargeCall', 'createDemoRoom', 'createLiveRoom', 'draftCard', 'enforceCapacity', 'evictExpired', 'externalTurn',
    'hydrate', 'joinAsAgent', 'onChange', 'other', 'reserveInvite', 'resume', 'rooms', 'sealCard', 'seatLink', 'stop',
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
  room.turnCount = room.maxTurns; // the cap is already reached
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
  assert.throws(() => domain.answerDemo(domain.createDemoRoom(), 'A', 'accept'), (e) => e.code === 409);
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
  const r = await start(path.join(src, 'index.js'), { PORT: '0', BIND_HOST: '127.0.0.1', SIGNIN: 'off', DROP_DATA_DIR: dir });
  assert.ok(r.exited !== undefined && r.exited !== 0, 'expected a non-zero exit\n' + r.out);
  assert.equal(r.out.split('\n').filter((l) => l.includes('app.init_failed')).length, 1, r.out);
  assert.equal(r.out.includes('store.load_failed'), false);
  await r.stop();
});

// ---------- item 5: domain fixes (D6, D7, D10, D11, D13, D15, D17) ----------

// Calls one MCP tool through lib/mcp.handle with the app's ops; resolves the raw response text.
async function mcpCall(app, name, args) {
  const req = { method: 'POST', headers: {}, socket: { remoteAddress: '1.2.3.4' } };
  let body = '';
  const res = { writeHead() {}, end: (b) => { body = b || ''; } };
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
  await mcp.handle(req, res, app.ops, { readBody: async () => rpc, clientIp: () => '1.2.3.4' });
  return body;
}

const pxpLib = require('../lib/pxp');
const DRAFT = { text: 'hello', name: 'Ann' };
const draftCode = async (domain, room, body = DRAFT) => {
  try { await domain.draftCard(room, 'A', body); return 200; } catch (e) { assert.ok(e instanceof domain.ApiError, 'an ApiError, got ' + e); return e.code; }
};

test('D6: a refused draft changes nothing on the seat, and the counter stops at the limit', T, async (t) => {
  const { domain } = setup(t);
  const room = liveRoom(domain);
  for (let i = 0; i < 5; i++) assert.equal(await draftCode(domain, room), 200);
  const seat = room.seats.A;
  const card = JSON.stringify(seat.card);
  assert.equal(await draftCode(domain, room, { text: 'MALLORY-TEXT', name: 'Mallory' }), 429);
  assert.equal(seat.name, 'Ann', 'the refused name was not applied');
  assert.equal(seat.draftText, 'hello', 'the refused text was not applied');
  assert.equal(seat.drafts, 5, 'a refusal does not count');
  assert.equal(JSON.stringify(seat.card), card);
});

test('D6: ten concurrent drafts make at most five proxy calls, and the rest get 429', T, async (t) => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const proxy = fakeProxy([], { draftCard: async () => { calls++; await gate; return { principal: { name: 'x' }, goal: 'g', must_haves: ['m'] }; } });
  const { domain } = setup(t, { proxy });
  const room = liveRoom(domain);
  const all = Array.from({ length: 10 }, () => draftCode(domain, room));
  release();
  const codes = await Promise.all(all);
  assert.equal(calls, 5);
  assert.equal(codes.filter((c) => c === 200).length, 5);
  assert.equal(codes.filter((c) => c === 429).length, 5);
});

test('D6: a failed draft (502) emits the room, so the counter and name are saved and listeners hear it', T, async (t) => {
  const proxy = fakeProxy([], { draftCard: async () => { throw new Error('nope'); } });
  const { domain, app } = setup(t, { proxy });
  const room = liveRoom(domain);
  const seen = [];
  domain.onChange((r) => seen.push(r.id));
  const saved = [];
  const save = app.store.save;
  app.store.save = (id) => { saved.push(id); return save(id); };
  const version = room.version || 0;
  assert.equal(await draftCode(domain, room), 502);
  assert.equal(room.seats.A.drafts, 1);
  assert.ok(seen.includes(room.id), 'listeners heard the failed draft');
  assert.ok(saved.includes(room.id), 'the failed draft was saved');
  assert.ok(room.version > version);
});

test('D10: a draft that resolves after the seat was sealed is discarded with 409 and the sealed card is untouched', T, async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const proxy = fakeProxy([], { draftCard: async () => { await gate; return { principal: { name: 'x' }, goal: 'DRAFTED-GOAL', must_haves: ['m'] }; } });
  const { domain } = setup(t, { proxy });
  const room = liveRoom(domain);
  const pending = domain.draftCard(room, 'A', DRAFT);
  const refused = assert.rejects(pending, (e) => e instanceof domain.ApiError && e.code === 409 && /Card already sealed/.test(e.message));
  domain.sealCard(room, 'A', CARD('Ann'), 'test');
  const seat = room.seats.A;
  const sealed = JSON.parse(JSON.stringify(seat.card));
  const hash = seat.cardHash;
  release();
  await refused;
  assert.deepEqual(seat.card, sealed);
  assert.equal(seat.cardHash, hash);
  assert.equal(pxpLib.hashOf(seat.card), seat.cardHash, 'the hash still matches the card');
  const entry = room.ledger.find((e) => e.type === 'card_sealed');
  assert.equal(entry.data.card_hash, seat.cardHash);
  assert.equal(pxpLib.verifyLedger(room.ledger).ok, true);
});

test('D11: a card sealed with deeply nested amendments gets amendments [], and every room still saves', T, async (t) => {
  const { domain, app, file } = setup(t);
  const room = liveRoom(domain);
  const other = liveRoom(domain);
  let deep = [];
  for (let i = 0; i < 20000; i++) deep = [deep];
  const card = Object.assign(CARD('Ann'), { amendments: deep });
  domain.sealCard(room, 'A', card, 'test');
  assert.deepEqual(room.seats.A.card.amendments, []);
  assert.equal(room.seats.A.cardHash, pxpLib.hashOf(room.seats.A.card));
  app.store.flush();
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(onDisk.rooms[room.id] && onDisk.rooms[other.id], 'every room was saved');
  assert.deepEqual(onDisk.rooms[room.id].seats.A.card.amendments, []);
});

test('D11: input amendments are dropped; only an answer adds them', T, async (t) => {
  const { domain } = setup(t, { turns: [ESCALATE, PROPOSE, AGREE] });
  const room = liveRoom(domain);
  domain.sealCard(room, 'A', Object.assign(CARD('Ann'), { amendments: [{ question: 'q', answer: 'forged', at: 'x' }] }), 'test');
  domain.sealCard(room, 'B', CARD('Ben'), 'test');
  assert.deepEqual(room.seats.A.card.amendments, []);
  await settle(room);
  domain.answerEscalation(room, 'A', 'Real answer.', 'test');
  assert.equal(room.seats.A.card.amendments.length, 1);
  assert.equal(room.seats.A.card.amendments[0].answer, 'Real answer.');
});

test('D13: a proxy error leaves no upstream text in room.error, the view for either seat, or MCP get_room', T, async (t) => {
  const MARKER = 'UPSTREAM-MARKER-' + Math.random();
  const { domain, app, out } = setup(t, { turns: [new Error(`Unexpected token ${MARKER} in JSON`)] });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'error');
  assert.equal(room.error, "The AI service didn't respond.");
  for (const seat of ['A', 'B']) assert.ok(!JSON.stringify(app.view(room, seat, room.seats[seat].token)).includes(MARKER), 'view as ' + seat);
  assert.ok(!JSON.stringify(app.view(room, null, null)).includes(MARKER), 'view as a spectator');
  const raw = await mcpCall(app, 'get_room', { link: app.ops.seatLink(room, 'B') });
  assert.ok(raw.includes(room.error), 'the fixed sentence reaches next_action');
  assert.ok(!raw.includes(MARKER), 'MCP get_room');
  assert.ok(!out.join('').includes(MARKER), 'the log never carries the message');
  assert.equal(out.join('').split('\n').filter((l) => /event="room\.run_failed"/.test(l)).length, 1);
});

test('MCP next_action on an error room reads as two clean sentences, with no doubled full stop', T, async (t) => {
  const { domain, app } = setup(t, { turns: [new Error('boom')] });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  const raw = await mcpCall(app, 'get_room', { link: app.ops.seatLink(room, 'A') });
  assert.ok(raw.includes("The room hit an error: The AI service didn't respond. Your principal can press Resume in the web view."), raw);
  assert.ok(!raw.includes('..'), 'no doubled full stop');
});

test('D13: the draft 502 is a fixed sentence, and the detail goes only to the log', T, async (t) => {
  const MARKER = 'DRAFT-MARKER-' + Math.random();
  const proxy = fakeProxy([], { draftCard: async () => { throw new Error('upstream said ' + MARKER); } });
  const { domain, out } = setup(t, { proxy });
  const room = liveRoom(domain);
  await assert.rejects(domain.draftCard(room, 'A', DRAFT), (e) => e instanceof domain.ApiError && e.code === 502
    && e.message === "Couldn't draft the card right now. Try again, or fill it in yourself." && !e.message.includes(MARKER));
  const log = out.join('');
  assert.ok(!log.includes(MARKER));
  assert.equal(log.split('\n').filter((l) => /event="room\.draft_failed"/.test(l)).length, 1, log);
  assert.ok(log.includes(`room="${room.id}"`));
});

test('D15: a demo room refuses answerEscalation (the MCP path) and stays paused; answerDemo still works', T, async (t) => {
  const { domain } = setup(t);
  const room = domain.createDemoRoom();
  sealBoth(domain, room);
  await settle(room);
  assert.equal(room.status, 'paused');
  const seat = room.pending.seat;
  const question = room.pending.question;
  assert.throws(() => domain.answerEscalation(room, seat, 'FREE-TEXT-ANSWER', 'mcp'),
    (e) => e instanceof domain.ApiError && e.code === 400 && /Demo rooms run scripted proxies/.test(e.message));
  assert.equal(room.status, 'paused');
  assert.equal(room.pending.question, question);
  assert.equal(room.seats[seat].card.amendments.length, 0, 'no free-text amendment');
  assert.equal(room.branch, undefined);
  domain.answerDemo(room, seat, Object.keys(demo.choices)[0]);
  assert.equal(room.status, 'negotiating');
  assert.equal(room.seats[seat].card.amendments.length, 1);
  await settle(room);
  assert.equal(room.status, 'agreed');
});

test('D7: authSeat accepts only the exact token on an own seat A or B', T, async (t) => {
  const { authSeat } = require('../lib/view');
  const { domain } = setup(t);
  const room = liveRoom(domain);
  const tok = room.seats.A.token;
  assert.equal(authSeat(room, 'A', tok), room.seats.A);
  assert.equal(authSeat(room, 'B', room.seats.B.token), room.seats.B);
  assert.equal(authSeat(room, 'A', tok + ' '), null, 'a trailing space is a different token');
  assert.equal(authSeat(room, 'A', ' ' + tok), null);
  assert.equal(authSeat(room, 'A', tok.slice(0, -1)), null);
  assert.equal(authSeat(room, 'B', tok), null);
  for (const bad of ['é', 'é'.repeat(70), '', undefined, null, 0, {}, [tok + 'x'], [tok], { toString: 1 }, { toString: () => tok }]) assert.equal(authSeat(room, 'A', bad), null, typeof bad);
  for (const seatId of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'a', 'AB', '', undefined, null, ['A']]) {
    assert.equal(authSeat(room, seatId, tok), null, String(seatId));
  }
  assert.equal(authSeat(null, 'A', tok), null);
  room.seats.C = { token: 'c' };
  assert.equal(authSeat(room, 'C', 'c'), null, 'a stray own key is still not a seat');
});

test('D7: the view for a prototype-key seat or a multibyte token is a spectator view, never a throw', T, async (t) => {
  const { domain, app } = setup(t);
  const room = liveRoom(domain);
  for (const seat of ['constructor', '__proto__', 'toString']) assert.equal(app.view(room, seat, room.seats.A.token).seat, null, seat);
  assert.equal(app.view(room, 'A', 'é').seat, null);
  assert.equal(app.view(room, 'A', room.seats.A.token + ' ').seat, null);
  assert.equal(app.view(room, 'A', room.seats.A.token).seat, 'A');
});

// ---------- D17: passcode ----------

function gatedSetup(t, { perIp = '100' } = {}) {
  const dir = mkTmp('rooms-pass-');
  t.after(() => rmTmp(dir));
  const clock = { t: Date.parse('2026-03-01T10:00:00Z'), sleep: async () => {} };
  clock.now = () => clock.t;
  const app = createApp({
    config: loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: dir, PER_IP_DAILY: perIp, DAILY_ROOM_LIMIT: '1000' }), secrets: loadSecrets({ ROOM_PASSCODE: 'x' }),
    log: createLog({ stream: { write() {} } }), proxy: fakeProxy([]), clock,
  });
  t.after(() => app.close());
  const make = (ip, passcode) => {
    try { return { room: app.domain.createLiveRoom(ip, { topic: 'T', nameA: 'a', nameB: 'b', modeA: 'external', modeB: 'external', passcode }) }; } catch (e) { return { code: e.code, message: e.message }; }
  };
  return { app, dir, clock, make };
}

test('D17: ten wrong passcodes from one address, then 429 even for the right one; other addresses and the next day are fine', T, async (t) => {
  const { app, clock, make } = gatedSetup(t);
  for (let i = 0; i < 10; i++) assert.equal(make('9.9.9.9', 'nope' + i).code, 403, 'guess ' + i);
  const blocked = make('9.9.9.9', 'x');
  assert.equal(blocked.code, 429);
  assert.equal(blocked.message, 'Too many wrong passcodes. Try again tomorrow.');
  assert.equal(make('9.9.9.9', 'nope').code, 429, 'still blocked');
  assert.ok(make('8.8.8.8', 'x').room, 'another address is unaffected');
  assert.equal(app.store.state.usage.failedByIp['9.9.9.9'], 10);
  clock.t += 24 * 3600 * 1000;
  assert.ok(make('9.9.9.9', 'x').room, 'the counter resets the next day');
  assert.equal(app.store.state.usage.failedByIp['9.9.9.9'], undefined);
});

test('D17: the right passcode on the third attempt creates the room, and the guesses are persisted in usage', T, async (t) => {
  const { app, dir, make } = gatedSetup(t);
  assert.equal(make('7.7.7.7', 'a').code, 403);
  assert.equal(make('7.7.7.7', 'b').code, 403);
  assert.ok(make('7.7.7.7', 'x').room, 'created');
  assert.equal(app.store.state.usage.failedByIp['7.7.7.7'], 2);
  app.store.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8')).usage.failedByIp['7.7.7.7'], 2);
});

test('D17: odd passcode values are wrong passcodes, not crashes; a 403 does not use the room quota', T, async (t) => {
  const { app, make } = gatedSetup(t, { perIp: '1' });
  for (const bad of [undefined, null, 5, {}, ['x'], 'x ', 'X', 'é']) assert.equal(make('6.6.6.6', bad).code, 403, String(bad));
  assert.equal(app.store.state.usage.total, 0);
  assert.ok(make('5.5.5.5', 'x').room);
  assert.equal(make('5.5.5.5', 'x').code, 429, 'the room quota still applies after a right passcode');
});

// ---------- gate-2 fixes ----------

test('draft in flight: busy stays true until the last of three overlapping drafts settles, and no seat flag is stored', T, async (t) => {
  const gates = [];
  const proxy = fakeProxy([], { draftCard: () => new Promise((r) => gates.push(() => r({ principal: { name: 'x' }, goal: 'g', must_haves: ['m'] }))) });
  const { domain } = setup(t, { proxy });
  const room = liveRoom(domain);
  assert.equal(domain.busy(room), false);
  const ps = [1, 2, 3].map(() => domain.draftCard(room, 'A', DRAFT));
  assert.equal(domain.busy(room), true);
  assert.equal('drafting' in room.seats.A, false);
  gates[0](); await ps[0];
  assert.equal(domain.busy(room), true);
  gates[1](); await ps[1];
  assert.equal(domain.busy(room), true);
  gates[2](); await ps[2];
  assert.equal(domain.busy(room), false);
});

test('busy is true while the turn loop runs, and a failed draft clears it', T, async (t) => {
  const proxy = fakeProxy([PROPOSE], { draftCard: async () => { throw new Error('x'); } });
  const { domain } = setup(t, { proxy });
  const room = liveRoom(domain);
  assert.equal(await draftCode(domain, room), 502);
  assert.equal(domain.busy(room), false);
  sealBoth(domain, room);
  assert.equal(domain.busy(room), true);
  await settle(room);
});

test('a draft that finishes after its room was evicted is discarded with 404', T, async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const proxy = fakeProxy([], { draftCard: async () => { await gate; return { principal: { name: 'x' }, goal: 'g', must_haves: ['m'] }; } });
  const { domain } = setup(t, { proxy });
  const room = liveRoom(domain);
  const p = domain.draftCard(room, 'A', DRAFT);
  const refused = assert.rejects(p, (e) => e.code === 404 && e.message === 'Room not found');
  domain.rooms.delete(room.id);
  release();
  await refused;
  assert.equal(room.seats.A.card, null);
});

test('a draft whose proxy throws an ApiError passes it through as itself', T, async (t) => {
  const { ApiError } = require('../lib/rooms');
  const proxy = fakeProxy([], { draftCard: async () => { throw new ApiError(429, 'Budget spent for this room.'); } });
  const { domain } = setup(t, { proxy });
  const room = liveRoom(domain);
  await assert.rejects(domain.draftCard(room, 'A', DRAFT), (e) => e instanceof ApiError && e.code === 429 && e.message === 'Budget spent for this room.');
});

test('room.error by cause: AI service, a client-safe ApiError from the proxy, or anything else in the room', T, async (t) => {
  const { ApiError } = require('../lib/rooms');
  const ai = setup(t, { turns: [new Error('upstream detail')] });
  const r1 = liveRoom(ai.domain); sealBoth(ai.domain, r1); await settle(r1);
  assert.equal(r1.error, "The AI service didn't respond.");

  const budget = setup(t, { turns: [new ApiError(409, 'Upstream-chosen text that is not a fixed sentence.')] });
  const r2 = liveRoom(budget.domain); sealBoth(budget.domain, r2); await settle(r2);
  assert.equal(r2.error, "The AI service didn't respond.", 'only a fixed sentence is stored');

  const bad = { get message() { throw new Error('ledger bug MARKER-X'); } };
  const own = setup(t, { turns: [bad] });
  const r3 = liveRoom(own.domain); sealBoth(own.domain, r3); await settle(r3);
  assert.equal(r3.status, 'error');
  assert.equal(r3.error, 'Something went wrong in this room.');
  assert.ok(!JSON.stringify(own.app.view(r3, null, null)).includes('MARKER-X'));
});

test('hydrate replaces a legacy raw error with the generic sentence and keeps the fixed ones', T, async (t) => {
  const MARKER = 'LEGACY-MARKER-' + Math.random();
  const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const [a, b, c] = ['nomode01', 'interr001', 'paused0001'];
  Object.assign(data.rooms[a], { status: 'error', error: `Unexpected token ${MARKER} in JSON` });
  Object.assign(data.rooms[b], { status: 'error', error: "The AI service didn't respond." });
  Object.assign(data.rooms[c], { error: null });
  const { domain, app } = setup(t, { content: JSON.stringify(data) });
  const room = domain.rooms.get(a);
  assert.equal(room.error, 'Something went wrong in this room.');
  assert.equal(domain.rooms.get(b).error, "The AI service didn't respond.");
  assert.equal(domain.rooms.get(c).error, null);
  for (const seat of ['A', 'B', null]) assert.ok(!JSON.stringify(app.view(room, seat, seat && room.seats[seat].token)).includes(MARKER), String(seat));
  const raw = await mcpCall(app, 'get_room', { link: app.ops.seatLink(room, 'A') });
  assert.ok(!raw.includes(MARKER));
  assert.ok(raw.includes('Something went wrong in this room.'));
});

test('answerDemo refuses a live room', T, async (t) => {
  const { domain } = setup(t, { turns: [ESCALATE] });
  const room = liveRoom(domain);
  sealBoth(domain, room);
  await settle(room);
  assert.throws(() => domain.answerDemo(room, 'A', 'accept'), (e) => e instanceof domain.ApiError && e.code === 400);
  assert.equal(room.status, 'paused');
  assert.equal(room.pending.seat, 'A');
});

test('pxp.str coerces only primitives: an object with a hostile toString is empty, not a throw', T, async (t) => {
  assert.equal(pxpLib.str({ toString: 1 }), '');
  assert.equal(pxpLib.str([' a ']), 'a', 'an array of primitives reads as it always did');
  assert.equal(pxpLib.str(['spec']), 'spec');
  assert.equal(pxpLib.str(['a', 1]), 'a,1');
  assert.equal(pxpLib.str(['a', null, undefined, true]), 'a,,,true');
  assert.equal(pxpLib.str([{ toString: 1 }]), '');
  assert.equal(pxpLib.str([['a']]), '');
  assert.equal(pxpLib.str({ a: 1 }), '');
  assert.equal(pxpLib.str(5), '5');
  assert.equal(pxpLib.str(true), 'true');
  assert.equal(pxpLib.str('  x '), 'x');
  assert.equal(pxpLib.str(null), '');
  const { domain } = setup(t);
  const room = liveRoom(domain);
  assert.equal(await draftCode(domain, room, { text: { toString: 1 }, name: 'Ann' }), 400);
  assert.equal(await draftCode(domain, room, { text: 'hi', name: { toString: 1 } }), 200, 'a bad name falls back to the seat name');
});

test('MCP send_envelope with an object message or hostile fields does not crash the server', T, async (t) => {
  const { domain, app } = setup(t, { turns: [] });
  const room = liveRoom(domain, { modeA: 'external', modeB: 'external' });
  domain.joinAsAgent(room, 'A', 'Test agent');
  sealBoth(domain, room);
  await settle(room);
  const link = app.ops.seatLink(room, 'A');
  const raw = await mcpCall(app, 'send_envelope', { link, message: { toString: 1 }, status: { toString: 1 }, claims: [{ text: { toString: 1 }, origin: 'stated', ref: { toString: 1 } }], proposal: { terms: [{ toString: 1 }, 'ok'] } });
  const json = JSON.parse(raw);
  assert.notEqual(json.result.content[0].text, 'Server error', raw);
});

test('D17: 500 keys cap the table; a shared overflow key has its own limit of 50; known addresses are never affected', T, async (t) => {
  const { app, clock, make } = gatedSetup(t);
  const usage = app.store.state.usage;
  const keys = () => Object.keys(usage.failedByIp);
  const ip = (i) => `10.${i >> 8}.${i & 255}.1`;
  for (let i = 0; i < 500; i++) assert.equal(make(ip(i), 'wrong').code, 403);
  assert.equal(keys().length, 500);
  assert.equal(usage.failedByIp.overflow, undefined);
  for (let i = 500; i < 530; i++) assert.equal(make(ip(i), 'wrong').code, 403);
  assert.equal(keys().length, 501, '500 keys plus overflow');
  assert.equal(usage.failedByIp.overflow, 30);
  assert.equal(usage.failedByIp[ip(500)], undefined, 'no new key once the table is full');
  assert.ok(make('11.1.1.1', 'x').room, 'a new address with the right passcode still works');
  assert.ok(make(ip(3), 'x').room, 'an address already in the table is unaffected');
  for (let i = 0; i < 20; i++) make(ip(600 + i), 'wrong');
  assert.equal(usage.failedByIp.overflow, 50);
  const blocked = make('11.1.1.2', 'x');
  assert.equal(blocked.code, 429, 'overflow is spent');
  assert.equal(blocked.message, 'Too many wrong passcodes. Try again tomorrow.');
  assert.ok(make(ip(4), 'x').room, 'a known address still works while overflow is spent');
  for (let i = 0; i < 10; i++) make(ip(7), 'wrong');
  assert.equal(make(ip(7), 'x').code, 429, 'a known address keeps its own limit of 10');
  assert.equal(keys().length, 501);
  clock.t += 24 * 3600 * 1000;
  assert.ok(make('11.1.1.2', 'x').room, 'the next day resets everything');
  assert.deepEqual(keys(), []);
});

test('D17: failed guesses are keyed by IPv4, any IPv4-mapped form, or the IPv6 /64; zones, brackets and garbage are normalised', T, async (t) => {
  const { app, make } = gatedSetup(t);
  for (const ip of ['::ffff:1.2.3.4', '1.2.3.4', '::ffff:0102:0304', '0:0:0:0:0:ffff:1.2.3.4', '0:0:0:0:0:ffff:102:304', '[::ffff:1.2.3.4]']) make(ip, 'w');
  for (const ip of ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:0db8:0001:0002::1', '[2001:db8:1:2::9]']) make(ip, 'w');
  make('2001:db8:1:3::1', 'w');
  for (const ip of ['fe80::1%eth0', 'fe80::2%wlan0']) make(ip, 'w');
  for (const ip of ['x'.repeat(200), 'not an ip', '', 'unknown', '1.2.3', '::g']) make(ip, 'w');
  const f = app.store.state.usage.failedByIp;
  assert.equal(f['1.2.3.4'], 6);
  assert.equal(f['2001:0db8:0001:0002'], 3);
  assert.equal(f['2001:0db8:0001:0003'], 1);
  assert.equal(f['fe80:0000:0000:0000'], 2);
  assert.equal(f.invalid, 6);
  for (const k of Object.keys(f)) assert.ok(k.length <= 64, k.slice(0, 20));
});

test('a wrong passcode saves usage only: no room is serialised again', T, async (t) => {
  const { app, make } = gatedSetup(t);
  const rooms = [make('1.1.1.1', 'x').room, make('2.2.2.2', 'x').room];
  let count = 0;
  for (const r of rooms) Object.defineProperty(r, 'probe', { enumerable: true, get() { count++; return 1; } });
  app.store.flush();
  const base = count;
  assert.ok(base >= 2, 'the probe sees serialisation');
  assert.equal(make('3.3.3.3', 'wrong').code, 403);
  app.store.flush();
  assert.equal(count, base, 'a wrong guess did not re-serialise the rooms');
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.config.dataDir, 'rooms.json'), 'utf8')).usage.failedByIp['3.3.3.3'], 1);
});

test('a sourced claim whose ref is an array of primitives is not downgraded (the protocol is unchanged)', T, async (t) => {
  const { domain } = setup(t);
  const room = liveRoom(domain, { modeA: 'external', modeB: 'external' });
  sealBoth(domain, room);
  const env = pxpLib.buildEnvelope(room, 'A', { claims: [{ text: 'a fact', origin: 'sourced', ref: ['spec'] }, { text: 'junk', origin: 'sourced', ref: [{ toString: 1 }] }] });
  assert.equal(env.claims[0].origin, 'sourced');
  assert.equal(env.claims[0].ref, 'spec');
  assert.equal(env.claims[1].origin, 'assumed', 'an unusable ref is still an assumption');
});

test('a new room id is drawn again while the store reports it as a skipped room', T, (t) => {
  const { app, domain } = setup(t);
  const seen = [];
  const SKIPPED = 3;
  app.store.isSkipped = (kind, id) => { assert.equal(kind, 'room'); seen.push(id); return seen.length <= SKIPPED; };
  const room = domain.createDemoRoom();
  assert.equal(seen.length, SKIPPED + 1, 'three ids were refused, the fourth was taken');
  assert.equal(room.id, seen[SKIPPED]);
  assert.ok(!seen.slice(0, SKIPPED).includes(room.id));
});

// Plays the given bytes in order for the room ids (id(8)); every other randomBytes call is the real one.
function withIdSources(sources, fn) {
  const crypto = require('node:crypto');
  const real = crypto.randomBytes;
  const queue = sources.slice();
  crypto.randomBytes = (n, ...rest) => (n === 8 && queue.length ? Buffer.alloc(8, queue.shift()) : real(n, ...rest));
  try { return fn(); } finally { crypto.randomBytes = real; }
}

test('a new room id is drawn again when it equals the id of a room that exists', T, (t) => {
  const { domain } = setup(t);
  withIdSources([1, 1, 2], () => {
    const first = domain.createDemoRoom();
    const second = domain.createDemoRoom();
    assert.notEqual(second.id, first.id, 'the second draw was the same id, so it was drawn again');
    assert.equal(domain.rooms.size, 2, 'the first room was not overwritten');
    assert.equal(domain.rooms.get(first.id), first);
  });
});

test('a new room id is drawn again when the store says it is a skipped room, though no live room has it', T, (t) => {
  const { app, domain } = setup(t);
  let refused;
  app.store.isSkipped = (kind, id) => { if (refused === undefined) { refused = id; return true; } return false; };
  withIdSources([1, 2], () => {
    const room = domain.createDemoRoom();
    assert.ok(refused, 'the store was asked');
    assert.notEqual(room.id, refused);
  });
});
