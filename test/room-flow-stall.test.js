'use strict';
// A stalled room: MAX_TURNS=1 on its own server, one external AI turn over /mcp, and the cap ends it. Its own
// file, so it runs in parallel with the demo-flow tests.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ROOT } = require('../test-support/paths');
const { start, mkTmp, rmTmp, postJson, getView } = require('../test-support/server');
const { loadPure } = require('../test-support/source');

const { mod: RoomView } = loadPure('room-view');
const { mod: AgreementView } = loadPure('agreement-view', { allowRequire: true });

// The /mcp endpoint answers JSON or a stream, so it needs to be told which it may send.
const MCP_HEADERS = { accept: 'application/json, text/event-stream' };

test('a room that hits the turn limit is a no-deal for the agreement page', async () => {
  const stallDir = mkTmp('room-flow-stall-');
  const srv = await start(path.join(ROOT, 'index.js'), { PORT: '0', BIND_HOST: '127.0.0.1', DROP_DATA_DIR: stallDir, MAX_TURNS: '1' });
  try {
    assert.strictEqual(srv.exited, undefined, 'server exited early: ' + srv.out);
    const url = `http://127.0.0.1:${srv.port}`;
    const created = await postJson(url, '/api/rooms', { topic: 'Shared roof', nameA: 'Lerato Mokoena', nameB: 'Kwame Asante', modeA: 'external', modeB: 'external' });
    assert.strictEqual(created.status, 201);
    const { id, links } = created.json;
    const tok = (seat) => new URL(links[seat], 'http://x').searchParams.get('t');
    const card = RoomView.cardFromFields({ goal: 'Agree who pays for the roof', must_haves: 'Work starts in May' }, { name: 'X', role: 'Owner' });
    for (const seat of ['A', 'B']) assert.strictEqual((await postJson(url, `/api/rooms/${id}/seats/${seat}/seal`, { token: tok(seat), card })).status, 200);

    const sent = await postJson(url, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'send_envelope', arguments: { link: url + links.A, message: 'Opening position.', status: 'continue' } },
    }, MCP_HEADERS);
    assert.ok(!sent.json.result.isError, JSON.stringify(sent.json));

    const [seatView, spectator] = await Promise.all([getView(url, id, 'A', tok('A')), getView(url, id)]).then((pair) => pair.map((v) => v.R));

    for (const R of [seatView, spectator]) {
      assert.strictEqual(R.status, 'stalled');
      assert.strictEqual(AgreementView.state(R), 'no-deal');
      assert.strictEqual(AgreementView.heading(R, R.seat), 'No deal reached');
      assert.strictEqual(R.maxTurns, 1, 'the view carries the turn limit the reason names');
      assert.deepStrictEqual(AgreementView.outcome(R), { tone: 'warn', text: "No deal. The AIs didn't agree within 1 turn." });
      assert.strictEqual(AgreementView.noDealReason(R), "The AIs didn't agree within 1 turn.");
      assert.match(AgreementView.summaryText(R, R.seat), /No deal was reached\./);
    }
  } finally {
    await srv.stop();
    rmTmp(stallDir);
  }
});
