'use strict';
// Characterisation of the engine end to end, through a spawned server: the MCP turn loop, seat-action codes,
// contract snapshots and leak checks. No ANTHROPIC_API_KEY, so every live room has two external seats.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../test-support/paths');
const { bootServer, client, waitFor, assertNoSecrets, sleep } = require('../test-support/http');
const { openSse, firstSseEvent } = require('../test-support/sse');

const T = { timeout: 30000 };
const MAX_TURNS = 6;
const FORBIDDEN = 'This link does not control that seat.';
const TOOLS_JSON = JSON.parse(JSON.stringify(require('../lib/mcp').TOOLS));
let srv = null;
let base = '';
let getJson = null;
let post = null;

before(async () => {
  srv = await bootServer('engine-flow-', { MAX_TURNS: String(MAX_TURNS), DEMO_DELAY_MS: '1', DAILY_ROOM_LIMIT: '1000', PER_IP_DAILY: '1000' });
  base = srv.base;
  ({ getJson, post } = client(base));
});

after(async () => {
  if (srv) await srv.stop();
});

// ---------- helpers ----------

let rpcId = 0;
async function rpc(body, init) {
  const res = await fetch(base + '/mcp', Object.assign({ method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }, init));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

// Returns { isError, out, raw }: out is structuredContent for a success and the message text for an error,
// raw is the whole JSON-RPC response text (so a leak into content[0].text is seen too).
async function call(name, args) {
  const { json, text } = await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(json && json.result, 'expected a JSON-RPC result for ' + name + ': ' + text);
  const r = json.result;
  if (r.isError) {
    assert.notStrictEqual(r.content[0].text, 'Server error', name + ' crashed instead of refusing');
    return { isError: true, out: r.content[0].text, raw: text };
  }
  return { isError: false, out: r.structuredContent, raw: text };
}

async function okRaw(name, args) {
  const r = await call(name, args);
  assert.strictEqual(r.isError, false, name + ' failed: ' + r.out);
  return r;
}
const ok = async (name, args) => (await okRaw(name, args)).out;
async function refused(name, args) {
  const r = await call(name, args);
  assert.strictEqual(r.isError, true, name + ' should have been refused');
  return r;
}

// One distinct marker per private card field and seat, so a leak of any field is caught.
const FIELDS = ['goal', 'must_haves', 'may_agree_to', 'must_never', 'escalate_when', 'known_facts'];
const markers = (seat) => ({
  goal: `MK-${seat}-GOAL-5521`, must_haves: [`MK-${seat}-MUST-5522`], may_agree_to: [`MK-${seat}-MAY-5523`],
  must_never: [`MK-${seat}-NEVER-5524`], escalate_when: [`MK-${seat}-ESC-5525`], known_facts: [`MK-${seat}-FACT-5526`],
});
const markerList = (seat) => { const m = markers(seat); return FIELDS.reduce((l, f) => l.concat(m[f]), []); };
const cardFor = (seat) => Object.assign({ principal: { name: seat === 'A' ? 'Alice' : 'Bob' } }, markers(seat));
const other = (s) => (s === 'A' ? 'B' : 'A');

const tokenOf = (link) => new URL(link).searchParams.get('t');
const linkFor = (room, seat, token) => `${base}/room/${room.id}?seat=${seat}&t=${token}`;

// A live room with both external seats joined and (optionally) both cards sealed.
async function newRoom({ seal = true } = {}) {
  const made = await ok('create_room', { topic: 'Engine flow', your_principal: 'Alice', counterpart: 'Bob', counterpart_proxy: 'external' });
  const link = { A: made.your_link, B: made.invite_link_for_counterpart };
  const room = { id: made.room_id, link, tok: { A: tokenOf(link.A), B: tokenOf(link.B) }, made };
  await ok('join_room', { link: room.link.B, agent_name: 'Agent B' });
  if (seal) {
    room.sealA = await ok('seal_intent_card', { link: room.link.A, card: cardFor('A') });
    room.sealB = await ok('seal_intent_card', { link: room.link.B, card: cardFor('B') });
  }
  return room;
}

const keys = (o) => Object.keys(o).sort();
const sorted = (l) => l.slice().sort();
const restView = async (room, seat) => (await getJson(`/api/rooms/${room.id}?seat=${seat}&t=${room.tok[seat]}`)).json;

// What a viewer must never see: the card markers and token of every seat but its own. An anonymous or
// unauthenticated viewer (null) sees neither seat's. (Live rooms here have no drafts; draftText is checked in store-load.)
function secretsFor(room, viewer) {
  const out = [];
  for (const s of ['A', 'B']) if (s !== viewer) out.push(...markerList(s), room.tok[s]);
  return out;
}

// The viewer sees nothing of the other seat, and (positive control) does see its own card.
function assertSeatOnly(text, room, seat, where) {
  assertNoSecrets(text, secretsFor(room, seat), where);
  for (const m of markerList(seat)) assert.ok(text.includes(m), `${where}: positive control, own marker ${m} missing`);
}

// ---------- two external seats: the full run ----------

test('create, join and seal x2: the second seal already shows negotiating, and it is A\'s turn', T, async () => {
  const room = await newRoom();
  assert.strictEqual(room.sealA.status, 'drafting', 'one card sealed is not enough to start');
  assert.strictEqual(room.sealB.status, 'negotiating', 'run() flips the status before the second seal returns');
  assert.strictEqual(room.sealB.your_turn, false);
  const a = await ok('get_room', { link: room.link.A });
  assert.strictEqual(a.status, 'negotiating');
  assert.strictEqual(a.your_turn, true);
  assert.strictEqual(a.you.card_sealed, true);
  assert.strictEqual(a.counterpart.card_sealed, true);
});

test('alternating envelopes reach agreement and get_brief returns the brief', T, async () => {
  const room = await newRoom();
  const sent = await ok('send_envelope', {
    link: room.link.A, message: 'Opening offer', status: 'continue',
    claims: [{ text: 'We can ship in May', origin: 'assumed' }],
    proposal: { terms: ['Ship in May', 'Pay on delivery'], depends_on: ['new1'] },
  });
  assert.strictEqual(sent.accepted_envelope.seq, 1);
  assert.strictEqual(sent.room.status, 'negotiating');
  assert.strictEqual(sent.room.your_turn, false);

  const b = await ok('get_room', { link: room.link.B });
  assert.strictEqual(b.your_turn, true);
  assert.strictEqual(b.claims_to_review.length, 1);

  const agreed = await ok('send_envelope', { link: room.link.B, message: 'Deal', status: 'agree', reviews: [{ claim_id: b.claims_to_review[0].id, verdict: 'accept' }] });
  assert.strictEqual(agreed.accepted_envelope.status, 'agree');
  assert.strictEqual(agreed.room.status, 'agreed');
  assert.ok(agreed.room.brief_url);

  const got = await ok('get_brief', { link: room.link.A });
  assert.strictEqual(got.status, 'agreed');
  assert.ok(got.brief);
  assert.strictEqual(got.brief.outcome, 'agreed');
  assert.deepStrictEqual(got.brief.agreement.terms, ['Ship in May', 'Pay on delivery']);
  assert.strictEqual(got.brief.ledger_ok, true);
  // get_brief also works with a bare room id (characterised: reads are unauthenticated).
  const bare = await ok('get_brief', { room_id: room.id });
  assert.deepStrictEqual(bare.brief.agreement.terms, ['Ship in May', 'Pay on delivery']);
  const a = await ok('get_room', { link: room.link.A });
  assert.strictEqual(a.your_turn, false);
});

test('escalation pauses the room; answering returns a negotiating view immediately', T, async () => {
  const room = await newRoom();
  const esc = await ok('send_envelope', { link: room.link.A, message: 'Need my principal', status: 'escalate', escalation: { question: 'May I go higher?', reason: 'outside card' } });
  assert.strictEqual(esc.room.status, 'paused');
  assert.ok(esc.room.pending_question);

  const a = await ok('get_room', { link: room.link.A });
  assert.strictEqual(a.status, 'paused');
  assert.strictEqual(a.pending_question, esc.room.pending_question);
  const b = await ok('get_room', { link: room.link.B });
  assert.strictEqual(b.pending_question, null, 'the question is only shown to the seat that asked');

  // Answering for the wrong seat is refused, and nothing changes.
  await refused('answer_escalation', { link: room.link.B, answer: 'nope' });
  const still = await ok('get_room', { link: room.link.A });
  assert.strictEqual(still.status, 'paused');
  assert.strictEqual(still.pending_question, esc.room.pending_question);

  const answered = await ok('answer_escalation', { link: room.link.A, answer: 'Yes, up to 10%' });
  assert.strictEqual(answered.status, 'negotiating');
  assert.strictEqual(answered.your_turn, true, 'the escalating proxy resumes');
  assert.strictEqual(answered.pending_question, null);
});

test('turn limit: MAX_TURNS continue envelopes stall the room and get_brief returns a brief', T, async () => {
  const room = await newRoom();
  let last = null;
  for (let i = 0; i < MAX_TURNS; i++) {
    last = await ok('send_envelope', { link: room.link[i % 2 === 0 ? 'A' : 'B'], message: 'turn ' + (i + 1), status: 'continue' });
    assert.strictEqual(last.room.status, i < MAX_TURNS - 1 ? 'negotiating' : 'stalled', 'after turn ' + (i + 1));
  }
  const got = await ok('get_brief', { link: room.link.B });
  assert.strictEqual(got.status, 'stalled');
  assert.ok(got.brief);
  assert.strictEqual(got.brief.outcome, 'no_agreement');
  assert.strictEqual(got.brief.ledger_ok, true);
  assert.strictEqual(got.brief.turns, MAX_TURNS);
  // A stalled room takes no more turns.
  await refused('send_envelope', { link: room.link.A, message: 'late', status: 'continue' });
});

test('send_envelope out of turn is an error and records nothing', T, async () => {
  const room = await newRoom();
  await refused('send_envelope', { link: room.link.B, message: 'too early', status: 'continue' });
  const a = await ok('get_room', { link: room.link.A });
  assert.strictEqual(a.transcript.length, 0, 'the refused envelope was not recorded');
  assert.strictEqual(a.your_turn, true, 'and it is still A\'s turn');
});

test('send_envelope before both cards are sealed is an error', T, async () => {
  const room = await newRoom({ seal: false });
  await ok('seal_intent_card', { link: room.link.A, card: cardFor('A') });
  await refused('send_envelope', { link: room.link.A, message: 'early', status: 'continue' });
});

test('send_envelope while the room is paused is an error for both seats, and the room is unchanged', T, async () => {
  const room = await newRoom();
  await ok('send_envelope', { link: room.link.A, message: 'Need my principal', status: 'escalate', escalation: { question: 'Q?' } });
  await refused('send_envelope', { link: room.link.A, message: 'again', status: 'continue' });
  await refused('send_envelope', { link: room.link.B, message: 'me too', status: 'continue' });
  const a = await ok('get_room', { link: room.link.A });
  assert.strictEqual(a.status, 'paused');
  assert.strictEqual(a.transcript.length, 1);
  assert.strictEqual(a.turn_count, 1);
});

test('wait_for_turn returns at once when it is your turn, and times out otherwise', T, async () => {
  const room = await newRoom();
  const [mine, theirs] = await Promise.all([
    ok('wait_for_turn', { link: room.link.A, timeout_seconds: 1 }),
    ok('wait_for_turn', { link: room.link.B, timeout_seconds: 1 }),
  ]);
  assert.strictEqual(mine.timed_out, false);
  assert.strictEqual(mine.your_turn, true);
  assert.strictEqual(mine.room_id, room.id);
  assert.strictEqual(theirs.timed_out, true);
  assert.strictEqual(theirs.your_turn, false);
  assert.strictEqual(theirs.room_id, room.id);
});

test('wait_for_turn wakes up when the other seat moves', T, async () => {
  const room = await newRoom();
  const t0 = Date.now();
  const waiting = ok('wait_for_turn', { link: room.link.B, timeout_seconds: 3 });
  await sleep(200);
  await ok('send_envelope', { link: room.link.A, message: 'your move', status: 'continue' });
  const woke = await waiting;
  assert.ok(Date.now() - t0 >= 150, 'the call blocked until A moved, it did not return at once');
  assert.strictEqual(woke.your_turn, true);
  assert.strictEqual(woke.timed_out, false);
  assert.strictEqual(woke.transcript.length, 1);
});

test('live escalation to agreement: the answered escalation clears the dispute and B agrees', T, async () => {
  const room = await newRoom();
  const terms = ['Ship in May'];
  // A claims and proposes, resting on its own claim.
  await ok('send_envelope', { link: room.link.A, message: 'Offer', status: 'continue', claims: [{ text: 'Stock is ready', origin: 'assumed' }], proposal: { terms, depends_on: ['new1'] } });
  // B challenges that claim and escalates to its principal.
  const esc = await ok('send_envelope', { link: room.link.B, message: 'Cannot verify', status: 'escalate', reviews: [{ claim_id: 'A1.1', verdict: 'challenge', reason: 'no source' }], escalation: { question: 'Accept unverified stock?' } });
  assert.strictEqual(esc.room.status, 'paused');
  const answered = await ok('answer_escalation', { link: room.link.B, answer: 'Yes, accept it' });
  assert.strictEqual(answered.status, 'negotiating');
  assert.strictEqual(answered.your_turn, true, 'the escalating proxy resumes');
  await ok('send_envelope', { link: room.link.B, message: 'My principal agrees in principle', status: 'continue' });
  // A proposes again, with the same dependency.
  await ok('send_envelope', { link: room.link.A, message: 'Offer again', status: 'continue', proposal: { terms, depends_on: ['A1.1'] } });
  const done = await ok('send_envelope', { link: room.link.B, message: 'Deal', status: 'agree' });
  assert.strictEqual(done.room.status, 'agreed');
  assert.strictEqual(done.accepted_envelope.protocol_flags, undefined, 'accepted without being withheld');
  const brief = (await ok('get_brief', { link: room.link.A })).brief;
  assert.deepStrictEqual(brief.agreement.terms, terms);
  assert.strictEqual(brief.escalations.length, 1);
  assert.strictEqual(brief.escalations[0].seat, 'B');
  assert.ok(brief.escalations[0].answer);
  assert.ok(brief.unverified_dependencies.some((c) => c.id === 'A1.1'), 'the unverified claim is carried into the brief');
  assert.strictEqual(brief.ledger_ok, true);
});

test('live: agreeing on a proposal that rests on a claim you challenged is withheld', T, async () => {
  const room = await newRoom();
  await ok('send_envelope', { link: room.link.A, message: 'Offer', status: 'continue', claims: [{ text: 'Stock is ready', origin: 'assumed' }], proposal: { terms: ['T'], depends_on: ['new1'] } });
  await ok('send_envelope', { link: room.link.B, message: 'Cannot verify', status: 'continue', reviews: [{ claim_id: 'A1.1', verdict: 'challenge', reason: 'no source' }] });
  await ok('send_envelope', { link: room.link.A, message: 'Offer again', status: 'continue', proposal: { terms: ['T'], depends_on: ['A1.1'] } });
  const tried = await ok('send_envelope', { link: room.link.B, message: 'Deal', status: 'agree' });
  assert.strictEqual(tried.accepted_envelope.status, 'continue');
  assert.ok(tried.accepted_envelope.protocol_flags && tried.accepted_envelope.protocol_flags.length === 1);
  assert.strictEqual(tried.room.status, 'negotiating');
});

// ---------- HTTP surface ----------

test('seat actions: unknown room 404, unknown seat 400, bad token 403, sealing twice 409', T, async () => {
  const room = await newRoom({ seal: false });
  const url = (seat) => `/api/rooms/${room.id}/seats/${seat}/seal`;

  assert.strictEqual((await getJson('/api/rooms/nope0000')).status, 404);
  assert.strictEqual((await post('/api/rooms/nope0000/seats/A/seal', { token: room.tok.A, card: cardFor('A') })).status, 404);
  assert.strictEqual((await post(url('C'), { token: room.tok.A, card: cardFor('A') })).status, 400);
  assert.strictEqual((await post(url('A'), { token: 'wrong-token', card: cardFor('A') })).status, 403);
  assert.strictEqual((await post(url('A'), { card: cardFor('A') })).status, 403, 'no token');
  assert.strictEqual((await post(url('A'), { token: room.tok.B, card: cardFor('A') })).status, 403, 'the other seat\'s token');

  const first = await post(url('A'), { token: room.tok.A, card: cardFor('A') });
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual(keys(first.json), ['card_hash', 'ok']);
  assert.strictEqual(first.json.ok, true);
  assert.strictEqual((await post(url('A'), { token: room.tok.A, card: cardFor('A') })).status, 409);
});

test('seat actions that make no sense right now', T, async () => {
  const [ready, fresh, demoRes] = await Promise.all([newRoom(), newRoom({ seal: false }), post('/api/demo', {})]);
  const demo = demoRes.json;
  const act = (room, seat, action, extra) => post(`/api/rooms/${room.id}/seats/${seat}/${action}`, Object.assign({ token: room.tok[seat] }, extra));
  const table = [
    ['answer with nothing pending', () => act(ready, 'A', 'answer', { answer: 'x' }), 409],
    ['resume with nothing to resume', () => act(ready, 'A', 'resume', {}), 409],
    ['draft on a sealed seat', () => act(ready, 'A', 'draft', { text: 'brief', name: 'Alice' }), 409],
    ['draft without an API key', () => act(fresh, 'A', 'draft', { text: 'brief', name: 'Alice' }), 503],
    ['unknown action', () => act(ready, 'A', 'bogus', {}), 404],
    ['unknown route under a room', () => getJson(`/api/rooms/${ready.id}/nothing`), 404],
    ['demo answer with nothing pending', () => post(`/api/rooms/${demo.id}/seats/A/answer`, { token: demo.token, option: 'dedupe' }), 409],
    ['draft in a demo room', () => post(`/api/rooms/${demo.id}/seats/A/draft`, { token: demo.token, text: 'x', name: 'n' }), 400],
  ];
  for (const [name, fn, code] of table) assert.strictEqual((await fn()).status, code, name);
  // None of that changed the ready room.
  assert.strictEqual((await restView(ready, 'A')).status, 'negotiating');
});

test('POST /api/rooms: a live room with two external seats, 201 and {id, links, modes}', T, async () => {
  const r = await post('/api/rooms', { topic: 'REST-made room', modeA: 'external', modeB: 'external' });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(keys(r.json), ['id', 'links', 'modes']);
  assert.deepStrictEqual(keys(r.json.links), ['A', 'B']);
  assert.deepStrictEqual(r.json.modes, { A: 'external', B: 'external' });
  assert.ok(r.json.links.A.startsWith(`/room/${r.json.id}?seat=A&t=`));
  assert.ok(r.json.links.B.startsWith(`/room/${r.json.id}?seat=B&t=`));
  const view = (await getJson(`/api/rooms/${r.json.id}`)).json;
  assert.strictEqual(view.status, 'drafting');
  assert.strictEqual(view.demo, false);
  // A built-in seat needs the API key this server does not have.
  assert.strictEqual((await post('/api/rooms', { topic: 'x' })).status, 503);
});

test('REST answer over a live room returns a negotiating view immediately', T, async () => {
  const room = await newRoom();
  await ok('send_envelope', { link: room.link.A, message: 'Need my principal', status: 'escalate', escalation: { question: 'Q?' } });
  assert.strictEqual((await restView(room, 'A')).status, 'paused');
  const res = await post(`/api/rooms/${room.id}/seats/A/answer`, { token: room.tok.A, answer: 'Go ahead' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.json, { ok: true });
  const v = await restView(room, 'A');
  assert.strictEqual(v.status, 'negotiating', 'run() ran synchronously inside the answer');
  assert.strictEqual(v.pending, null);
  assert.strictEqual(v.waitingOn, 'A');
  assert.strictEqual(v.thinking, null);
  assert.strictEqual(v.ledgerCheck.ok, true);
});

test('demo room over REST: sealing starts the script, the escalation answer branches and resumes', T, async () => {
  const demo = (await post('/api/demo', {})).json;
  assert.deepStrictEqual(keys(demo), ['id', 'token']);
  for (const seat of ['A', 'B']) {
    const sealed = await post(`/api/rooms/${demo.id}/seats/${seat}/seal`, { token: demo.token });
    assert.strictEqual(sealed.status, 200);
  }
  const v = await waitFor(async () => (await getJson(`/api/rooms/${demo.id}?seat=A&t=${demo.token}`)).json, (x) => x.status === 'paused', { what: 'the demo to escalate' });
  assert.strictEqual(v.status, 'paused');
  assert.ok(v.pending);
  assert.deepStrictEqual(keys(v.pending), ['options', 'question', 'reason', 'seat', 'seq']);
  assert.ok(Array.isArray(v.pending.options) && v.pending.options.length >= 2);
  for (const o of v.pending.options) assert.deepStrictEqual(keys(o), ['key', 'label']);
  const option = v.pending.options[0].key;

  const res = await post(`/api/rooms/${demo.id}/seats/${v.pending.seat}/answer`, { token: demo.token, option });
  assert.strictEqual(res.status, 200);
  const after = (await getJson(`/api/rooms/${demo.id}?seat=A&t=${demo.token}`)).json;
  assert.strictEqual(after.pending, null, 'the question is answered');
  assert.notStrictEqual(after.status, 'paused', 'run() resumed the demo synchronously');
  assert.strictEqual(after.ledgerCheck.ok, true);
  // The branches are owned by test/demo-copy.test.js, which runs them to the end.
});

test('GET /api/config has a fixed key set', T, async () => {
  const r = await getJson('/api/config');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(keys(r.json), ['live', 'maxTurns', 'mcpUrl', 'passcode', 'protocol', 'signin']);
  assert.strictEqual(r.json.live, false);
  assert.strictEqual(r.json.maxTurns, MAX_TURNS);
});

test('GET /health has a fixed key set', T, async () => {
  const r = await getJson('/health');
  assert.deepStrictEqual(keys(r.json), ['build', 'live', 'ok', 'rooms', 'store', 'storeOk']);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.store, 'file');
  assert.strictEqual(r.json.storeOk, true);
});

// ---------- MCP protocol edges ----------

test('MCP initialize returns protocolVersion and serverInfo', T, async () => {
  const { status, json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'edge-test' } } });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.result.protocolVersion, '2025-06-18');
  assert.strictEqual(typeof json.result.serverInfo.name, 'string');
  assert.ok(json.result.capabilities.tools);
});

test('MCP: a notification gets 202, GET gets 405, invalid JSON gets -32700, an unknown tool is an isError result', T, async () => {
  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(note.status, 202);
  assert.strictEqual(note.json, null);

  const get = await fetch(base + '/mcp');
  assert.strictEqual(get.status, 405);
  await get.text();

  const bad = await rpc('{ not json');
  assert.strictEqual(bad.json.error.code, -32700);

  const unknown = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  assert.strictEqual(unknown.status, 200);
  assert.strictEqual(unknown.json.result.isError, true);

  const method = await rpc({ jsonrpc: '2.0', id: 10, method: 'no/such/method' });
  assert.strictEqual(method.json.error.code, -32601);
});

test('MCP batch: results come back as an array, matched by id, and notifications get none', T, async () => {
  const { status, json } = await rpc([
    { jsonrpc: '2.0', id: 11, method: 'ping' },
    { jsonrpc: '2.0', id: 12, method: 'tools/list' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]);
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(json));
  assert.strictEqual(json.length, 2);
  assert.deepStrictEqual(json.map((m) => m.id), [11, 12]);
  assert.deepStrictEqual(json[0].result, {});
  assert.ok(Array.isArray(json[1].result.tools));
});

// ---------- contract snapshots ----------

const SEAT_PUBLIC = ['agent', 'cardHash', 'drafted', 'mode', 'name', 'role', 'sealed', 'sealedVia'];
const VIEW_KEYS = ['brief', 'claims', 'createdAt', 'demo', 'envelopes', 'error', 'id', 'interrupted', 'ledger', 'ledgerCheck', 'live', 'maxTurns', 'mcpUrl', 'pending', 'seat', 'seats', 'status', 'thinking', 'topic', 'turn', 'turnCount', 'waitingOn'];
const AGENT_VIEW_KEYS = ['brief_url', 'claims_to_review', 'counterpart', 'max_turns', 'next_action', 'pending_question', 'room_id', 'status', 'topic', 'transcript', 'turn_count', 'unverified_assumptions', 'web_view', 'you', 'your_turn'];
const BRIEF_KEYS = ['agreement', 'authority', 'challenged', 'depends_on', 'escalations', 'generated_at', 'ledger_head', 'ledger_ok', 'outcome', 'parties', 'protocol_flags', 'turns', 'unverified_dependencies', 'unverified_in_record'];

test('contract: key set of the REST room view, with and without a token', T, async () => {
  const room = await newRoom();
  const withToken = await restView(room, 'A');
  const noToken = (await getJson(`/api/rooms/${room.id}`)).json;
  assert.deepStrictEqual(keys(withToken), sorted(VIEW_KEYS));
  assert.deepStrictEqual(keys(noToken), sorted(VIEW_KEYS));
  assert.deepStrictEqual(keys(withToken.seats.A), sorted(SEAT_PUBLIC.concat(['card', 'draftText'])), 'own seat shows card and draftText');
  assert.deepStrictEqual(keys(withToken.seats.B), sorted(SEAT_PUBLIC));
  assert.deepStrictEqual(keys(noToken.seats.A), sorted(SEAT_PUBLIC));
  assert.deepStrictEqual(keys(noToken.seats.B), sorted(SEAT_PUBLIC));
  assert.strictEqual(withToken.seat, 'A');
  assert.strictEqual(noToken.seat, null);
  assert.deepStrictEqual(keys(withToken.ledger[0]), ['at', 'data', 'hash', 'n', 'prev', 'type']);
  assert.deepStrictEqual(keys(withToken.ledgerCheck), ['head', 'ok']);
  assert.deepStrictEqual(keys(withToken.seats.A.card), ['amendments', 'escalate_when', 'goal', 'known_facts', 'may_agree_to', 'must_haves', 'must_never', 'principal', 'pxp']);
});

test('contract: create_room result, agent view, wait_for_turn and get_brief shapes', T, async () => {
  const room = await newRoom({ seal: false });
  assert.deepStrictEqual(keys(room.made), ['counterpart_proxy', 'invite_link_for_counterpart', 'next_action', 'room_id', 'your_link']);
  await ok('seal_intent_card', { link: room.link.A, card: cardFor('A') });
  await ok('seal_intent_card', { link: room.link.B, card: cardFor('B') });

  const a = await ok('get_room', { link: room.link.A });
  assert.deepStrictEqual(keys(a), sorted(AGENT_VIEW_KEYS));
  assert.deepStrictEqual(keys(a.you), ['card', 'card_hash', 'card_sealed', 'principal', 'proxy', 'seat']);
  assert.deepStrictEqual(keys(a.counterpart), ['card_sealed', 'principal', 'proxy', 'seat']);
  const waits = await Promise.all([ok('wait_for_turn', { link: room.link.A, timeout_seconds: 1 }), ok('wait_for_turn', { link: room.link.B, timeout_seconds: 1 })]);
  assert.deepStrictEqual(keys(waits[0]), sorted(AGENT_VIEW_KEYS.concat(['timed_out'])));
  assert.deepStrictEqual(keys(waits[1]), sorted(AGENT_VIEW_KEYS.concat(['timed_out'])), 'also when it times out');

  const none = await ok('get_brief', { link: room.link.A });
  assert.deepStrictEqual(keys(none), ['brief', 'note', 'status']);
  assert.strictEqual(none.brief, null);
});

test('contract: envelope, claim, transcript, pending and brief shapes through a full run', T, async () => {
  const room = await newRoom();
  const sent = await ok('send_envelope', {
    link: room.link.A, message: 'Offer', status: 'continue',
    claims: [{ text: 'Rule says so', origin: 'stated', ref: 'must_never[0]' }, { text: 'Probably fine', origin: 'assumed' }],
    proposal: { terms: ['T1'], depends_on: ['new1'] },
  });
  assert.deepStrictEqual(keys(sent), ['accepted_envelope', 'room']);
  assert.deepStrictEqual(keys(sent.accepted_envelope), ['claims', 'from', 'message', 'proposal', 'seq', 'status']);
  assert.deepStrictEqual(keys(sent.accepted_envelope.claims[0]), ['id', 'origin', 'ref', 'text']);
  assert.deepStrictEqual(keys(sent.accepted_envelope.claims[1]), ['id', 'origin', 'text']);
  assert.deepStrictEqual(keys(sent.accepted_envelope.proposal), ['depends_on', 'hash', 'terms']);
  assert.deepStrictEqual(sent.accepted_envelope.proposal.depends_on, ['A1.1']);
  assert.deepStrictEqual(keys(sent.room.transcript[0]), ['claims', 'from', 'message', 'proposal', 'seq', 'status']);

  const esc = await ok('send_envelope', {
    link: room.link.B, message: 'Hmm', status: 'escalate', reviews: [{ claim_id: 'A1.1', verdict: 'accept' }, { claim_id: 'A1.2', verdict: 'challenge', reason: 'r' }],
    escalation: { question: 'Q?', reason: 'because' },
  });
  assert.deepStrictEqual(keys(esc.accepted_envelope), ['escalation', 'from', 'message', 'reviews', 'seq', 'status']);
  assert.deepStrictEqual(keys(esc.accepted_envelope.escalation), ['answer', 'question']);
  assert.deepStrictEqual(keys(esc.accepted_envelope.reviews[0]), ['claim_id', 'reason', 'verdict']);

  const paused = await restView(room, 'B');
  assert.deepStrictEqual(keys(paused.pending), ['options', 'question', 'reason', 'seat', 'seq']);
  assert.strictEqual(paused.pending.options, null, 'no options outside the demo');
  assert.deepStrictEqual(keys(paused.envelopes[0]), ['claims', 'from', 'intent_hash', 'message', 'proposal', 'proposal_hash', 'pxp', 'reviews', 'room', 'seq', 'status']);
  assert.deepStrictEqual(keys(paused.envelopes[0].from), ['agent', 'principal', 'seat', 'speaker']);
  assert.deepStrictEqual(keys(paused.envelopes[1]), ['claims', 'escalation', 'from', 'intent_hash', 'message', 'pxp', 'reviews', 'room', 'seq', 'status']);
  assert.deepStrictEqual(keys(paused.envelopes[1].escalation), ['question', 'reason']);
  const byId = {};
  for (const c of paused.claims) byId[c.id] = c;
  assert.deepStrictEqual(keys(byId['A1.1']), ['id', 'origin', 'ref', 'reviews', 'seat', 'seq', 'text', 'verified']);
  assert.deepStrictEqual(keys(byId['A1.2']), ['id', 'origin', 'reviews', 'seat', 'seq', 'text', 'verified']);
  assert.deepStrictEqual(keys(byId['A1.2'].reviews[0]), ['by', 'reason', 'seq', 'verdict']);

  await ok('answer_escalation', { link: room.link.B, answer: 'Fine' });
  const done = await ok('send_envelope', { link: room.link.B, message: 'Deal', status: 'agree' });
  assert.deepStrictEqual(keys(done.accepted_envelope), ['accepts', 'from', 'message', 'seq', 'status']);
  assert.deepStrictEqual(keys(done.accepted_envelope.accepts), ['proposal_hash', 'seq']);
  assert.strictEqual(done.room.status, 'agreed');

  const withBrief = await ok('get_brief', { link: room.link.A });
  assert.deepStrictEqual(keys(withBrief), ['brief', 'brief_url', 'status']);
  const brief = withBrief.brief;
  assert.deepStrictEqual(keys(brief), sorted(BRIEF_KEYS));
  assert.deepStrictEqual(keys(brief.parties), ['A', 'B']);
  assert.deepStrictEqual(keys(brief.parties.A), ['card_hash', 'name', 'proxy']);
  assert.deepStrictEqual(keys(brief.agreement), ['accepted_by', 'accepted_seq', 'proposal_hash', 'proposed_by', 'proposed_seq', 'terms']);
  assert.deepStrictEqual(keys(brief.escalations[0]), ['answer', 'principal', 'question', 'seat', 'via']);
  const bare = await ok('get_brief', { room_id: room.id });
  assert.deepStrictEqual(keys(bare), ['brief', 'brief_url', 'status']);

  const ledger = await getJson(`/api/rooms/${room.id}/ledger`);
  assert.deepStrictEqual(keys(ledger.json), ['check', 'ledger', 'protocol', 'room']);
  assert.strictEqual(ledger.json.room, room.id);
  assert.strictEqual(ledger.json.check.ok, true);
});

// Structure only: copy (description, title) may change freely; names, types, enums, limits and annotations may not.
// A key called description or title under `properties` is a real input name, so it is kept.
function structural(v, parentKey) {
  if (Array.isArray(v)) return v.map((x) => structural(x, parentKey));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (parentKey !== 'properties' && (k === 'description' || k === 'title')) continue;
      out[k] = structural(v[k], k);
    }
    return out;
  }
  return v;
}

test('contract: MCP TOOLS match the structural snapshot', () => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-support', 'fixtures', 'mcp-tools.snapshot.json'), 'utf8'));
  assert.deepStrictEqual(structural(TOOLS_JSON), snapshot);
});

test('contract: structural() keeps input names that happen to be called description or title', () => {
  assert.deepStrictEqual(structural({ description: 'x', properties: { description: { type: 'string', description: 'y' }, title: { type: 'string' } } }),
    { properties: { description: { type: 'string' }, title: { type: 'string' } } });
});

test('contract: tools/list over the wire has the same structure as TOOLS', T, async () => {
  const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepStrictEqual(structural(json.result.tools), structural(TOOLS_JSON));
});

// ---------- leak checks ----------

// Sealed live room whose cards carry unmistakable markers in every field, and the room is negotiating.
async function leakRoom() {
  const room = await newRoom();
  assert.strictEqual(room.sealB.status, 'negotiating');
  return room;
}

// Every channel for one seat: REST view, SSE first event, MCP get_room and wait_for_turn (raw JSON-RPC text).
async function checkSeatChannels(room, seat) {
  const rest = await getJson(`/api/rooms/${room.id}?seat=${seat}&t=${room.tok[seat]}`);
  assert.strictEqual(rest.json.id, room.id);
  assert.strictEqual(rest.json.seat, seat);
  assert.strictEqual(rest.json.seats[other(seat)].card, undefined);
  assert.strictEqual(rest.json.seats[other(seat)].draftText, undefined);
  assertSeatOnly(rest.text, room, seat, `REST view for ${seat}`);

  const sse = await firstSseEvent(base, `/api/rooms/${room.id}/events?seat=${seat}&t=${room.tok[seat]}`);
  assert.strictEqual(sse.json.id, room.id);
  assert.strictEqual(sse.json.seat, seat);
  assert.strictEqual(sse.json.seats[other(seat)].card, undefined);
  assertSeatOnly(sse.text, room, seat, `SSE first event for ${seat}`);

  const got = await okRaw('get_room', { link: room.link[seat] });
  assert.strictEqual(got.out.room_id, room.id);
  assertSeatOnly(got.raw, room, seat, `MCP get_room for ${seat}`);

  const waited = await okRaw('wait_for_turn', { link: room.link[seat], timeout_seconds: 1 });
  assert.strictEqual(waited.out.room_id, room.id);
  assertSeatOnly(waited.raw, room, seat, `MCP wait_for_turn for ${seat}`);
}

test('leak: each seat\'s token reveals only its own card, over REST, SSE and MCP', T, async () => {
  const room = await leakRoom();
  await Promise.all([checkSeatChannels(room, 'A'), checkSeatChannels(room, 'B')]);
});

test('leak: send_envelope responses carry nothing of the other seat either', T, async () => {
  const room = await leakRoom();
  const a = await okRaw('send_envelope', { link: room.link.A, message: 'hello', status: 'continue' });
  assert.strictEqual(a.out.room.room_id, room.id);
  assertSeatOnly(a.raw, room, 'A', 'send_envelope by A');
  const b = await okRaw('send_envelope', { link: room.link.B, message: 'hi', status: 'continue' });
  assertSeatOnly(b.raw, room, 'B', 'send_envelope by B');
});

test('leak: SSE broadcasts after a change reach each subscriber only with what it may see', T, async () => {
  const room = await leakRoom();
  const subs = {
    A: openSse(base, `/api/rooms/${room.id}/events?seat=A&t=${room.tok.A}`),
    B: openSse(base, `/api/rooms/${room.id}/events?seat=B&t=${room.tok.B}`),
    anon: openSse(base, `/api/rooms/${room.id}/events`),
  };
  try {
    for (const s of Object.values(subs)) await s.next(0);
    await ok('send_envelope', { link: room.link.A, message: 'a change', status: 'continue' });
    for (const s of Object.values(subs)) await s.next(1);
    for (const s of Object.values(subs)) await s.drain(); // every further broadcast of the same change

    for (const [who, s] of Object.entries(subs)) {
      assert.ok(s.events.length >= 2, who + ' got a broadcast');
      assert.strictEqual(s.events[1].json.envelopes.length, 1, who + ': the second event is the post-change view');
      for (const e of s.events) {
        assert.strictEqual(e.json.id, room.id);
        if (who === 'anon') {
          assert.strictEqual(e.json.seat, null);
          assert.strictEqual(e.json.seats.A.card, undefined);
          assert.strictEqual(e.json.seats.B.card, undefined);
          assertNoSecrets(e.text, secretsFor(room, null), 'anonymous SSE');
        } else {
          assert.strictEqual(e.json.seat, who);
          assert.strictEqual(e.json.seats[other(who)].card, undefined);
          assertSeatOnly(e.text, room, who, `SSE for ${who}`);
        }
      }
    }
  } finally {
    for (const s of Object.values(subs)) s.close();
  }
});

test('leak: a wrong token, a swapped seat or an unknown seat reveals nothing over REST, SSE and MCP', T, async () => {
  const room = await leakRoom();
  const bad = [['A', room.tok.B, 'A with the token of B'], ['B', room.tok.A, 'B with the token of A'], ['A', 'bad', 'A with a bad token'], ['C', room.tok.A, 'seat C']];
  const clean = (text, where) => assertNoSecrets(text, secretsFor(room, null), where);
  for (const [seat, tok, where] of bad) {
    const rest = await getJson(`/api/rooms/${room.id}?seat=${seat}&t=${tok}`);
    assert.strictEqual(rest.json.id, room.id, where);
    assert.strictEqual(rest.json.seat, null, where);
    clean(rest.text, 'REST, ' + where);

    const sse = await firstSseEvent(base, `/api/rooms/${room.id}/events?seat=${seat}&t=${tok}`);
    assert.strictEqual(sse.json.seat, null, where);
    assert.strictEqual(sse.json.seats.A.card, undefined);
    assert.strictEqual(sse.json.seats.B.card, undefined);
    clean(sse.text, 'SSE, ' + where);

    const link = linkFor(room, seat, tok);
    const g = await refused('get_room', { link });
    const s = await refused('send_envelope', { link, message: 'sneak', status: 'continue' });
    const w = await refused('wait_for_turn', { link, timeout_seconds: 1 });
    for (const r of [g, s, w]) {
      clean(r.raw, 'MCP, ' + where);
      if (seat !== 'C') assert.strictEqual(r.out, FORBIDDEN, where);
    }
  }
  // The refused envelopes were not recorded.
  assert.strictEqual((await ok('get_room', { link: room.link.A })).transcript.length, 0);
});

test('leak: no token means no cards and no tokens anywhere in the REST view, SSE or ledger', T, async () => {
  const room = await leakRoom();
  const clean = (text, where) => assertNoSecrets(text, secretsFor(room, null), where);
  const rest = await getJson(`/api/rooms/${room.id}`);
  assert.strictEqual(rest.json.id, room.id);
  assert.strictEqual(rest.json.seat, null);
  assert.strictEqual(rest.json.seats.A.card, undefined);
  assert.strictEqual(rest.json.seats.B.card, undefined);
  clean(rest.text, 'anonymous REST');

  const sse = await firstSseEvent(base, `/api/rooms/${room.id}/events`);
  assert.strictEqual(sse.json.id, room.id);
  clean(sse.text, 'anonymous SSE');

  const ledger = await getJson(`/api/rooms/${room.id}/ledger`);
  assert.strictEqual(ledger.status, 200);
  assert.strictEqual(ledger.json.room, room.id);
  assert.ok(ledger.json.ledger.length >= 3);
  clean(ledger.text, 'ledger');
});

test('leak: the demo room is the deliberate exception, the shared token shows both cards', T, async () => {
  const created = await post('/api/demo', {});
  assert.strictEqual(created.status, 201);
  const { id, token } = created.json;
  const withToken = (await getJson(`/api/rooms/${id}?seat=A&t=${token}`)).json;
  assert.strictEqual(withToken.demo, true);
  assert.ok(withToken.seats.A.card);
  assert.ok(withToken.seats.B.card, 'one person drives both sides in a demo');
  const noToken = await getJson(`/api/rooms/${id}`);
  assert.strictEqual(noToken.json.seats.A.card, undefined);
  assert.strictEqual(noToken.json.seats.B.card, undefined);
  assert.ok(!noToken.text.includes(token));
  // Seat B drives with the very same token.
  const asB = (await getJson(`/api/rooms/${id}?seat=B&t=${token}`)).json;
  assert.strictEqual(asB.seat, 'B');
  assert.ok(asB.seats.A.card && asB.seats.B.card);
  const sse = await firstSseEvent(base, `/api/rooms/${id}/events?seat=A&t=${token}`);
  assert.ok(sse.json.seats.A.card && sse.json.seats.B.card);
});
