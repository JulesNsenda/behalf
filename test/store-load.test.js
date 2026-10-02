'use strict';
// Boots the server on a copy of a hand-written store in today's on-disk format and checks the load rules.
// Every ledger in the fixture is dated 2026-01-01, so the rooms are old on purpose. The TTL variables below are set
// huge so that eviction, once it exists, can't remove them: this test must never depend on a room's age.
// Each test that changes a room has a room of its own, so the tests do not depend on their order.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../test-support/paths');
const { bootServer, client, waitFor, assertNoSecrets } = require('../test-support/http');
const { firstSseEvent } = require('../test-support/sse');

const T = { timeout: 30000 };
const FIXTURE = path.join(ROOT, 'test-support', 'fixtures', 'rooms.v0.json');
let srv = null;
let api = null;
let fixture = null;
let patchedDay = '';

const view = async (id) => (await api.getJson('/api/rooms/' + id)).json;
const seatToken = (id, seat) => fixture.rooms[id].seats[seat].token;
const resume = (id) => api.post(`/api/rooms/${id}/seats/A/resume`, { token: seatToken(id, 'A') });

// What a viewer must never see in a stored room: the other seat's token and draft. Anonymous (viewer null) sees neither seat's.
function secretsFor(id, viewer) {
  const out = [];
  for (const s of ['A', 'B']) {
    if (s === viewer) continue;
    out.push(seatToken(id, s), fixture.rooms[id].seats[s].draftText);
  }
  return out;
}

before(async () => {
  fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  // The stored usage day is patched to today, so the daily limit below is observable.
  const store = JSON.parse(JSON.stringify(fixture));
  patchedDay = new Date().toISOString().slice(0, 10);
  store.usage.day = patchedDay;
  srv = await bootServer('store-load-', {
    DEMO_DELAY_MS: '1', DAILY_ROOM_LIMIT: String(store.usage.total),
    ROOM_TTL_DAYS: '100000', DEMO_TTL_HOURS: '100000000', MAX_ROOMS: '100000',
  }, (dir) => fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify(store)));
  api = client(srv.base);
});

after(async () => {
  if (srv) await srv.stop();
});

test('the fixture itself is in the on-disk shape and its ledgers verify', () => {
  const pxp = require('../lib/pxp');
  assert.deepStrictEqual(Object.keys(fixture).sort(), ['rooms', 'usage']);
  for (const [id, room] of Object.entries(fixture.rooms)) {
    assert.strictEqual(room.id, id);
    assert.strictEqual(pxp.verifyLedger(room.ledger).ok, true, id);
    for (const s of ['A', 'B']) assert.ok(/^fake-token-/.test(room.seats[s].token), id + ' token must be obviously fake');
  }
});

test('every stored room loads, and every ledger verifies', T, async () => {
  const health = await api.getJson('/health');
  assert.strictEqual(health.json.rooms, Object.keys(fixture.rooms).length);
  for (const id of Object.keys(fixture.rooms)) {
    const v = await view(id);
    assert.strictEqual(v.id, id);
    assert.strictEqual(v.ledgerCheck.ok, true, id);
    assert.strictEqual(v.thinking, null, id + ': thinking is reset on load');
  }
});

test('a seat stored without a mode loads as builtin; stored modes are kept', T, async () => {
  const v = await view('nomode01');
  assert.strictEqual(fixture.rooms.nomode01.seats.A.mode, undefined, 'fixture precondition');
  assert.strictEqual(v.seats.A.mode, 'builtin');
  assert.strictEqual(v.seats.B.mode, 'external');
  assert.strictEqual(v.status, 'drafting', 'a drafting room is left alone');
});

test('negotiating with nobody waiting loads as paused and interrupted, with thinking reset', T, async () => {
  assert.strictEqual(fixture.rooms.interr001.waitingOn, null, 'fixture precondition');
  assert.strictEqual(fixture.rooms.interr001.thinking, 'B', 'fixture precondition');
  const v = await view('interr001');
  assert.strictEqual(v.status, 'paused');
  assert.strictEqual(v.interrupted, true);
  assert.strictEqual(v.thinking, null);
  assert.strictEqual(v.seats.A.mode, 'builtin');
  assert.strictEqual(v.envelopes.length, 1, 'history is kept');
});

test('negotiating while an external seat is awaited stays negotiating, with a stored thinking reset', T, async () => {
  assert.strictEqual(fixture.rooms.waiting001.thinking, 'A', 'fixture precondition');
  const v = await view('waiting001');
  assert.strictEqual(v.status, 'negotiating');
  assert.strictEqual(v.waitingOn, 'A');
  assert.strictEqual(v.interrupted, false);
  assert.strictEqual(v.thinking, null);
});

test('a paused room with a pending question stays paused and is not marked interrupted', T, async () => {
  const v = await view('paused0001');
  assert.strictEqual(v.status, 'paused');
  assert.strictEqual(v.interrupted, false);
  assert.ok(v.pending);
  assert.strictEqual(v.pending.seat, 'A');
  assert.strictEqual(v.pending.question, fixture.rooms.paused0001.pending.question);
});

test('the stored usage is loaded: a live room is refused once the stored daily total is spent', T, async (t) => {
  // The usage day was patched to today at boot; across UTC midnight the server resets it, so the check is moot.
  if (new Date().toISOString().slice(0, 10) !== patchedDay) return t.skip('UTC date changed since boot');
  const before = (await api.getJson('/health')).json.rooms;
  const res = await api.post('/api/rooms', { topic: 'x', modeA: 'external', modeB: 'external' });
  assert.strictEqual(res.status, 429);
  assert.strictEqual((await api.getJson('/health')).json.rooms, before, 'a refused room is not created');
});

test('a stored draft never reaches the other seat or an anonymous reader; the owner still sees it', T, async () => {
  const id = 'waiting001';
  const marker = fixture.rooms[id].seats.B.draftText;
  assert.ok(marker, 'fixture precondition');
  const tokA = seatToken(id, 'A');
  const tokB = seatToken(id, 'B');
  const restA = await api.getJson(`/api/rooms/${id}?seat=A&t=${tokA}`);
  assert.strictEqual(restA.json.seat, 'A');
  assertNoSecrets(restA.text, secretsFor(id, 'A'), 'REST view for A');
  assert.strictEqual(restA.json.seats.B.draftText, undefined);
  const sseA = await firstSseEvent(srv.base, `/api/rooms/${id}/events?seat=A&t=${tokA}`);
  assert.strictEqual(sseA.json.seat, 'A');
  assertNoSecrets(sseA.text, secretsFor(id, 'A'), 'SSE for A');
  assertNoSecrets((await api.getJson(`/api/rooms/${id}`)).text, secretsFor(id, null), 'anonymous REST view');
  const sseAnon = await firstSseEvent(srv.base, `/api/rooms/${id}/events`);
  assertNoSecrets(sseAnon.text, secretsFor(id, null), 'anonymous SSE');
  const restB = await api.getJson(`/api/rooms/${id}?seat=B&t=${tokB}`);
  assert.strictEqual(restB.json.seats.B.draftText, marker, 'positive control: B sees its own draft');
});

test('the finalise gap: an applied accepting envelope with no brief loads as paused and interrupted', T, async () => {
  const r = fixture.rooms.finalgap01;
  assert.strictEqual(r.waitingOn, null, 'fixture precondition');
  assert.strictEqual(r.brief, null, 'fixture precondition');
  assert.strictEqual(r.envelopes[r.envelopes.length - 1].status, 'agree', 'fixture precondition');
  const v = await view('finalgap01');
  assert.strictEqual(v.status, 'paused');
  assert.strictEqual(v.interrupted, true);
  assert.strictEqual(v.brief, null);
  assert.strictEqual(v.envelopes.length, 2);
  assert.ok(v.envelopes[1].accepts);
});

// Its own room (the same stored state as interr001), because resuming changes it.
test('resume on an interrupted built-in room (no API key) leaves paused at once; the stored running flag was reset', T, async () => {
  const id = 'resume0001';
  assert.strictEqual(fixture.rooms[id].running, true, 'fixture precondition');
  assert.strictEqual((await view(id)).status, 'paused', 'loaded as interrupted');
  const res = await resume(id);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.json, { ok: true });
  assert.notStrictEqual((await view(id)).status, 'paused', 'run() flips the status synchronously');
  const v = await waitFor(() => view(id), (x) => x.status !== 'negotiating', { what: 'the resumed room to leave negotiating' });
  // Without an API key the built-in proxy cannot take its turn, so the room ends in error.
  assert.strictEqual(v.status, 'error');
  assert.ok(v.error);
  assert.strictEqual(v.ledgerCheck.ok, true);
});

// Its own room too: nothing else touches demo000001.
test('a loaded demo room keeps its remaining script: resume plays it out', T, async () => {
  const id = 'demo000001';
  assert.strictEqual(fixture.rooms[id].script.length, 1, 'fixture precondition');
  const v = await view(id);
  assert.strictEqual(v.demo, true);
  assert.strictEqual(v.status, 'paused');
  assert.strictEqual(v.interrupted, true);
  assert.strictEqual(v.envelopes.length, 0);

  const res = await resume(id);
  assert.strictEqual(res.status, 200);

  const after = await waitFor(() => view(id), (x) => x.status !== 'negotiating' && x.status !== 'paused', { what: 'the demo script to play out' });
  assert.strictEqual(after.envelopes.length, 1, 'the one scripted step was played');
  assert.strictEqual(after.status, 'stalled', 'then the script ran out');
  assert.strictEqual(after.interrupted, false);
  assert.strictEqual(after.ledgerCheck.ok, true);
});
