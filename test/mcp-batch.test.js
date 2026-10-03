'use strict';
// lib/mcp.handle in-process with fake req/res and stub ops: the batch cap refuses before anything is dispatched.
const test = require('node:test');
const assert = require('node:assert/strict');
const mcp = require('../lib/mcp');

async function post(body, ops = {}) {
  const req = { method: 'POST', headers: {}, socket: { remoteAddress: '1.2.3.4' } };
  const out = { status: null, headers: null, body: '' };
  const res = { writeHead: (c, h) => { out.status = c; out.headers = h; }, end: (b) => { out.body = b || ''; } };
  await mcp.handle(req, res, ops, { readBody: async () => body, clientIp: () => '1.2.3.4' });
  return out;
}

const list = (id) => ({ jsonrpc: '2.0', id, method: 'tools/list' });

test('MAX_BATCH is 20', () => assert.equal(mcp.MAX_BATCH, 20));

test('a batch of exactly 20 is dispatched', async () => {
  const r = await post(Array.from({ length: 20 }, (_, i) => list(i + 1)));
  assert.equal(r.status, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.length, 20);
  assert.ok(b.every((x, i) => x.id === i + 1 && x.result && Array.isArray(x.result.tools)));
});

test('a batch of 21 is refused with 400 / -32600 and nothing is dispatched', async () => {
  let reads = 0;
  // The method getter runs on any read of a message (the initialize scan included); a refused batch reads nothing.
  const msgs = Array.from({ length: 21 }, () => ({ jsonrpc: '2.0', id: 1, get method() { reads += 1; return 'tools/list'; } }));
  const r = await post(msgs);
  assert.equal(r.status, 400);
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.deepEqual(JSON.parse(r.body), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch too large' } });
  assert.equal(reads, 0);
});

test('an oversized batch holding initialize does not open a session', async () => {
  let reads = 0;
  const counted = (m) => ({ ...m, get method() { reads += 1; return m.method; } });
  const msgs = [counted({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'x' } } }), ...Array.from({ length: 20 }, (_, i) => counted(list(i + 2)))];
  const before = mcp.sessionCount();
  const r = await post(msgs);
  assert.equal(r.status, 400);
  assert.equal(r.headers['mcp-session-id'], undefined);
  assert.equal(reads, 0);
  assert.equal(mcp.sessionCount(), before);
  // Control: the same shape within the cap does open a session, so the count above can fail.
  const ok = await post([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'x' } } }]);
  assert.ok(ok.headers['mcp-session-id']);
  assert.equal(mcp.sessionCount(), before + 1);
});

test('a non-array body and an empty array are unaffected', async () => {
  const one = await post(list(7));
  assert.equal(one.status, 200);
  assert.equal(JSON.parse(one.body).id, 7);
  const empty = await post([]);
  assert.equal(empty.status, 202);
});
