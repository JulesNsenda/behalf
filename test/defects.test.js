'use strict';
// Item 5 regressions that need the HTTP layer, through a spawned server: D7 (seat auth over REST, SSE and MCP),
// D14 (non-object JSON bodies) and D15 (MCP answer_escalation on a demo room). No ANTHROPIC_API_KEY, so live
// rooms have two external seats.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { bootServer, client, waitFor } = require('../test-support/http');
const { firstSseEvent } = require('../test-support/sse');

const T = { timeout: 30000 };
let srv = null;
let base = '';
let getJson = null;
let post = null;

before(async () => {
  srv = await bootServer('defects-', { DEMO_DELAY_MS: '1', DAILY_ROOM_LIMIT: '1000', PER_IP_DAILY: '1000' });
  base = srv.base;
  ({ getJson, post } = client(base));
});

after(async () => {
  if (srv) await srv.stop();
});

async function newRoom() {
  const r = await post('/api/rooms', { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'external', modeB: 'external' });
  assert.strictEqual(r.status, 201, r.text);
  const tok = (s) => new URL(r.json.links[s], base).searchParams.get('t');
  return { id: r.json.id, tokenA: tok('A'), tokenB: tok('B'), link: (s, t) => `${base}/room/${r.json.id}?seat=${s}&t=${encodeURIComponent(t)}` };
}

let rpcId = 0;
async function call(name, args) {
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const json = await res.json();
  assert.ok(json.result, JSON.stringify(json));
  const r = json.result;
  return r.isError ? { isError: true, out: r.content[0].text } : { isError: false, out: r.structuredContent };
}

// ---------- D7 ----------

test('D7 REST: a token with a trailing space is rejected, in the view and on a seat action', T, async () => {
  const room = await newRoom();
  const ok = await getJson(`/api/rooms/${room.id}?seat=A&t=${room.tokenA}`);
  assert.strictEqual(ok.json.seat, 'A');
  const sp = await getJson(`/api/rooms/${room.id}?seat=A&t=${encodeURIComponent(room.tokenA + ' ')}`);
  assert.strictEqual(sp.status, 200);
  assert.strictEqual(sp.json.seat, null);
  const act = await post(`/api/rooms/${room.id}/seats/A/resume`, { token: room.tokenA + ' ' });
  assert.strictEqual(act.status, 403, act.text);
});

test('D7 REST: prototype-key seats and multibyte tokens give a spectator view or 403, never a 500', T, async () => {
  const room = await newRoom();
  for (const seat of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const r = await getJson(`/api/rooms/${room.id}?seat=${seat}&t=${room.tokenA}`);
    assert.strictEqual(r.status, 200, seat + ' ' + r.text);
    assert.strictEqual(r.json.seat, null, seat);
  }
  const mb = await getJson(`/api/rooms/${room.id}?seat=A&t=%C3%A9`);
  assert.strictEqual(mb.status, 200, mb.text);
  assert.strictEqual(mb.json.seat, null);
  const act = await post(`/api/rooms/${room.id}/seats/A/resume`, { token: 'é' });
  assert.strictEqual(act.status, 403, act.text);
  const proto = await post(`/api/rooms/${room.id}/seats/constructor/resume`, { token: room.tokenA });
  assert.strictEqual(proto.status, 400, proto.text);
});

test('D7 SSE: odd seat and token params still get a 200 stream with a spectator first event, and the server stays healthy', T, async () => {
  const room = await newRoom();
  for (const q of ['seat=constructor&t=x', 'seat=__proto__&t=x', 'seat=toString&t=x', 'seat=A&t=%C3%A9', `seat=A&t=${room.tokenA}%20`]) {
    const ev = await firstSseEvent(base, `/api/rooms/${room.id}/events?${q}`);
    assert.strictEqual(ev.json.seat, null, q);
  }
  const ev = await firstSseEvent(base, `/api/rooms/${room.id}/events?seat=A&t=${room.tokenA}`);
  assert.strictEqual(ev.json.seat, 'A');
  assert.strictEqual((await getJson('/health')).status, 200);
});

test('D7 MCP: a trailing-space or multibyte token in the link is refused with the 403 message, not a crash', T, async () => {
  const room = await newRoom();
  const good = await call('get_room', { link: room.link('A', room.tokenA) });
  assert.strictEqual(good.isError, false, good.out);
  for (const t of [room.tokenA + ' ', 'é']) {
    const r = await call('get_room', { link: room.link('A', t) });
    assert.strictEqual(r.isError, true);
    assert.notStrictEqual(r.out, 'Server error', 'crashed instead of refusing');
    assert.match(r.out, /does not control that seat/);
  }
});

// ---------- D14 ----------

test('D14: a JSON body that is not an object is 400 Invalid JSON on a seat action and on POST /api/rooms', T, async () => {
  const room = await newRoom();
  for (const body of ['null', '[]', '5', '"x"', 'true']) {
    for (const url of [`/api/rooms/${room.id}/seats/A/resume`, '/api/rooms']) {
      const r = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.strictEqual(r.status, 400, `${url} ${body}: ${r.text}`);
      assert.deepStrictEqual(r.json, { error: 'Invalid JSON' });
    }
  }
  const empty = await getJson(`/api/rooms/${room.id}/seats/A/resume`, { method: 'POST' });
  assert.strictEqual(empty.status, 403, 'an empty body is still {}');
});

test('D14: MCP still takes a batch (an array body) and a single message', T, async () => {
  const batch = [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }];
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) });
  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json) && json.length === 2);
});

// ---------- D15 ----------

test('D15: MCP answer_escalation on a demo room is refused, the room stays paused, and the web answer still works', T, async () => {
  const d = await post('/api/demo', {});
  assert.strictEqual(d.status, 201);
  const { id, token } = d.json;
  for (const s of ['A', 'B']) assert.strictEqual((await post(`/api/rooms/${id}/seats/${s}/seal`, { token })).status, 200);
  const view = () => getJson(`/api/rooms/${id}?seat=A&t=${token}`).then((r) => r.json);
  const paused = await waitFor(view, (v) => v.status === 'paused' && v.pending, { what: 'the demo to pause' });
  const seat = paused.pending.seat;
  const r = await call('answer_escalation', { link: `${base}/room/${id}?seat=${seat}&t=${token}`, answer: 'FREE-TEXT-ANSWER' });
  assert.strictEqual(r.isError, true);
  assert.notStrictEqual(r.out, 'Server error');
  assert.match(r.out, /Demo rooms run scripted proxies/);
  const after = await view();
  assert.strictEqual(after.status, 'paused');
  assert.strictEqual(after.pending.question, paused.pending.question);
  assert.ok(!JSON.stringify(after).includes('FREE-TEXT-ANSWER'));
  const web = await post(`/api/rooms/${id}/seats/${seat}/answer`, { token, option: paused.pending.options[0].key });
  assert.strictEqual(web.status, 200, web.text);
  const done = await waitFor(view, (v) => v.status === 'agreed', { what: 'the demo to agree' });
  assert.strictEqual(done.ledgerCheck.ok, true);
});

test('D7/gate-2: an object token in a seat action body is a 403, never a 500', T, async () => {
  const room = await newRoom();
  for (const token of [{ toString: 1 }, [room.tokenA], { a: 1 }, 5]) {
    const r = await post(`/api/rooms/${room.id}/seats/A/resume`, { token });
    assert.strictEqual(r.status, 403, JSON.stringify(token) + ' ' + r.text);
  }
});
