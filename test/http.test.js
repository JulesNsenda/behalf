'use strict';
// lib/http in-process: createApp(...).listen(0) with a fake proxy and a no-op sleep. The spawned tests at the end
// (build fingerprint, signals) run index.js itself. Node-18-safe: no t.mock, no timers helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createApp } = require('../lib/app');
const { resolveStatic } = require('../lib/http');
const { loadConfig, loadSecrets } = require('../lib/config');
const { createLog } = require('../lib/log');
const { ROOT } = require('../test-support/paths');
const { baseEnv, start, mkTmp, rmTmp, makeSrc } = require('../test-support/server');
const { waitFor, sleep } = require('../test-support/http');

const T = { timeout: 30000 };
const fakeProxy = () => ({ live: () => false, takeTurn: async () => { throw new Error('unused'); }, draftCard: async () => ({}), mapAuthority: async () => [], MODEL: 'fake' });
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// An app listening on a free loopback port. `wrapView` replaces the view the web layer uses; `overrides` go to createApp.
async function boot(t, { overrides } = {}) {
  const dir = mkTmp('http-');
  const file = path.join(dir, 'data', 'rooms.json');
  const out = [];
  const log = createLog({ stream: { write: (s) => out.push(s) } });
  const config = loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: path.join(dir, 'data'), PUBLIC_URL: 'http://test.invalid' });
  const app = createApp({ config, secrets: loadSecrets({}), log, proxy: fakeProxy(), clock: { sleep: async () => {} }, file, ...overrides });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(async () => {
    await app.drain().catch(() => {});
    if (app.server.closeAllConnections) app.server.closeAllConnections();
    app.close();
    rmTmp(dir);
  });
  return { app, port, base: `http://127.0.0.1:${port}`, file, dir, out, d: app.diagnostics };
}

async function createDemo(base) {
  const res = await fetch(base + '/api/demo', { method: 'POST' });
  assert.equal(res.status, 201);
  return res.json();
}

// An SSE connection. ready resolves with the status at the response; closed turns true when the server ends it.
function openStream(port, url) {
  const c = { closed: false, status: null };
  c.req = http.get({ host: '127.0.0.1', port, path: url });
  c.ready = new Promise((resolve) => c.req.on('response', (res) => {
    c.status = res.statusCode;
    res.resume();
    res.on('close', () => { c.closed = true; });
    resolve();
  }));
  c.req.on('error', () => { c.closed = true; });
  c.drop = () => c.req.destroy();
  return c;
}
const ev = (id, q = '') => `/api/rooms/${id}/events${q}`;
const seatQ = (seat, token) => `?seat=${seat}&t=${encodeURIComponent(token)}`;

// The web layer on its own, over a fake domain: for the tests that control the view or the domain's events.
async function fakeWeb(t, view, { trustProxy = () => true, domainExtra, limits } = {}) {
  const { createHttpServer } = require('../lib/http');
  const room = { id: 'r1', seats: { A: { token: 'ta' }, B: { token: 'tb' } } };
  const listeners = [];
  const domain = { rooms: new Map([['r1', room]]), onChange: (fn) => { listeners.push(fn); return () => {}; }, ...domainExtra };
  const out = [];
  const log = createLog({ stream: { write: (x) => out.push(x) } });
  const h = createHttpServer({ domain, view, authSeat: (r, seat, tok) => (r.seats[seat] && r.seats[seat].token === tok ? r.seats[seat] : null), log, mcpHandle: () => {}, info: {}, trustProxy, limits });
  await new Promise((resolve) => h.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { h.close(); if (h.server.closeAllConnections) h.server.closeAllConnections(); });
  return { h, room, rooms: domain.rooms, listeners, out, port: h.server.address().port, d: h.diagnostics };
}

// ---- SSE ----
test('SSE: a first view that throws is logged, the stream is ended and nothing leaks', T, async (t) => {
  let calls = 0;
  const { port, d, out } = await fakeWeb(t, () => { if (calls++ === 0) throw new Error('boom'); return {}; });
  const c = openStream(port, ev('r1'));
  await waitFor(() => c.closed, (v) => v === true, { what: 'the stream to be ended' });
  assert.equal(d.streamCount('r1'), 0);
  assert.deepEqual(d.streamRooms(), []);
  assert.ok(out.join('').includes('http.unexpected'), 'logged');
  const next = openStream(port, ev('r1')); await next.ready;
  assert.equal(next.status, 200, 'the next stream is served');
  assert.equal(d.streamCount('r1'), 1);
  next.drop();
  await waitFor(() => d.streamCount('r1'), (n) => n === 0);
});

test('SSE limits: 25 anonymous -> 20 open and 5 refused with 204; open streams are never ended', T, async (t) => {
  const { port, base, d } = await boot(t);
  const { id } = await createDemo(base);
  const cs = [];
  for (let i = 0; i < 25; i++) { const c = openStream(port, ev(id)); cs.push(c); await c.ready; }
  assert.deepEqual(cs.map((c) => c.status), cs.map((_, i) => (i < 20 ? 200 : 204)));
  await sleep(100);
  assert.deepEqual(cs.slice(0, 20).map((c) => c.closed), new Array(20).fill(false), 'the open ones are untouched');
  assert.equal(d.streamCount(id), 20, 'refused requests left no subscriber');
  cs.forEach((c) => c.drop());
  await waitFor(() => d.streamCount(id), (n) => n === 0);
  assert.deepEqual(d.streamRooms(), [], 'the empty set was deleted');
});

test('SSE limits: an anonymous viewer and seat B do not share the seat A bucket', T, async (t) => {
  const { port, base, d } = await boot(t);
  const { id, token } = await createDemo(base); // a demo room's two seats share one token
  const b = openStream(port, ev(id, seatQ('B', token))); await b.ready;
  const anon = openStream(port, ev(id)); await anon.ready;
  assert.equal(b.status, 200);
  assert.equal(anon.status, 200);
  assert.equal(d.streamCount(id), 2);
  [b, anon].forEach((c) => c.drop());
  await waitFor(() => d.streamCount(id), (n) => n === 0);
});

test('SSE limits: a claimed seat with a wrong token counts as anonymous', T, async (t) => {
  const { port, base, d } = await boot(t);
  const { id, token } = await createDemo(base);
  const fake = []; for (let i = 0; i < 5; i++) { const c = openStream(port, ev(id, seatQ('A', 'wrong'))); fake.push(c); await c.ready; }
  const real = openStream(port, ev(id, seatQ('A', token))); await real.ready;
  assert.deepEqual(fake.map((c) => c.status), [200, 200, 200, 200, 200]);
  assert.equal(real.status, 200);
  await sleep(100);
  assert.ok(fake.every((c) => !c.closed) && !real.closed, 'nothing was ended: the fake claims sit in the anonymous bucket');
  // They fill the anonymous bucket, not seat A's: 15 more anonymous make 20, and the next is refused.
  const more = []; for (let i = 0; i < 15; i++) { const c = openStream(port, ev(id)); more.push(c); await c.ready; }
  const refused = openStream(port, ev(id)); await refused.ready;
  assert.equal(refused.status, 204);
  assert.ok(!real.closed, 'the real seat stream was not touched');
  [...fake, ...more, real].forEach((c) => c.drop());
  await waitFor(() => d.streamCount(id), (n) => n === 0);
});

test('SSE limits: a full seat bucket ends the oldest stream of that seat and accepts the newcomer', T, async (t) => {
  const { port, base, d } = await boot(t);
  const { id, token } = await createDemo(base);
  const bs = openStream(port, ev(id, seatQ('B', token))); await bs.ready;
  const anon = openStream(port, ev(id)); await anon.ready;
  const a = []; for (let i = 0; i < 6; i++) { const c = openStream(port, ev(id, seatQ('A', token))); a.push(c); await c.ready; }
  assert.deepEqual(a.map((c) => c.status), [200, 200, 200, 200, 200, 200]);
  await waitFor(() => a[0].closed, (v) => v === true, { what: 'the oldest seat A stream to be ended' });
  await sleep(100);
  assert.deepEqual(a.map((c) => c.closed), [true, false, false, false, false, false]);
  assert.ok(!bs.closed && !anon.closed, 'seat B and anonymous untouched');
  assert.equal(d.streamCount(id), 7);
  [...a, bs, anon].forEach((c) => c.drop());
  await waitFor(() => d.streamCount(id), (n) => n === 0);
});

test('SSE limits: anonymous streams stop at globalAnon, leaving headroom for live seat holders', T, async (t) => {
  const { port, rooms, d } = await fakeWeb(t, () => ({}), { limits: { globalAnon: 2, global: 4 } });
  rooms.set('r2', { id: 'r2', seats: { A: { token: 'ta' }, B: { token: 'tb' } } });
  const anon = [];
  for (const id of ['r1', 'r2']) { const c = openStream(port, ev(id)); anon.push(c); await c.ready; }
  const refused = openStream(port, ev('r1')); await refused.ready;
  assert.equal(refused.status, 204, 'the third anonymous stream is refused');
  const s1 = openStream(port, ev('r1', seatQ('A', 'ta'))); await s1.ready;
  const s2 = openStream(port, ev('r2', seatQ('A', 'ta'))); await s2.ready;
  assert.equal(s1.status, 200); assert.equal(s2.status, 200);
  const s3 = openStream(port, ev('r1', seatQ('B', 'tb'))); await s3.ready;
  assert.equal(s3.status, 204, 'all streams stop at global');
  assert.equal(d.streamCount('r1') + d.streamCount('r2'), 4);
  [...anon, s1, s2].forEach((c) => c.drop());
});

test('SSE: an evicted room ends its streams, and a change reaches the rest', T, async (t) => {
  const { port, d, listeners, room } = await fakeWeb(t, () => ({ ok: true }));
  const c = openStream(port, ev('r1')); await c.ready;
  assert.equal(d.streamCount('r1'), 1);
  assert.equal(listeners.length, 1);
  listeners[0](room, 'something-else');
  assert.equal(d.streamCount('r1'), 1, 'other kinds are ignored');
  listeners[0](room, 'evicted');
  await waitFor(() => c.closed, (v) => v === true, { what: 'the stream to be ended' });
  assert.equal(d.streamCount('r1'), 0);
  assert.deepEqual(d.streamRooms(), []);
});

test('SSE pings are cleared: no timers are left after every stream drops', T, async (t) => {
  const { app, port, base, d } = await boot(t);
  const { id } = await createDemo(base);
  await sleep(150);
  app.store.flush();
  const timers = () => process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length;
  const baseline = timers();
  const cs = []; for (let i = 0; i < 4; i++) { const c = openStream(port, ev(id)); cs.push(c); await c.ready; }
  assert.ok(timers() >= baseline + 4, 'each stream has a ping timer');
  cs.forEach((c) => c.drop());
  await waitFor(() => d.streamCount(id), (n) => n === 0);
  await waitFor(timers, (n) => n <= baseline, { what: 'the ping timers to be cleared' });
});

// ---- body parsing ----
test('REST bodies must be JSON objects; /mcp takes any JSON value', T, async (t) => {
  const { base } = await boot(t);
  const { id } = await createDemo(base);
  for (const url of ['/api/rooms', `/api/rooms/${id}/seats/A/seal`]) {
    for (const body of ['null', '[]', '[1,2]', '3', '"x"', '{bad']) {
      const res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(res.status, 400, `${url} ${body}`);
      assert.deepEqual(await res.json(), { error: 'Invalid JSON' });
    }
  }
  const batch = [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }];
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(batch) });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.ok(Array.isArray(out));
  assert.deepEqual(out.map((r) => r.id), [1, 2]);
  const bad = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
});

test('an oversize body gets a 413 answer, not a reset, on REST and /mcp', T, async (t) => {
  const { base, port } = await boot(t);
  const pad = (n) => JSON.stringify({ pad: 'x'.repeat(n) });
  const rest = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: pad(70 * 1024) });
  assert.equal(rest.status, 413);
  assert.deepEqual(await rest.json(), { error: 'Body too large' });
  assert.equal(rest.headers.get('connection'), 'close');
  const mcp = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: pad(300 * 1024) });
  assert.equal(mcp.status, 413);
  assert.equal(mcp.headers.get('access-control-allow-origin'), '*', 'declared oversize carries the CORS headers');
  assert.equal((await mcp.json()).error.code, -32600);
  // Chunked: no content-length to check up front, so the cut-off happens while reading.
  for (const [url, size] of [['/api/rooms', 70 * 1024], ['/mcp', 300 * 1024]]) {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res); });
      req.on('error', reject);
      req.write(pad(size)); req.end();
    });
    assert.equal(r.statusCode, 413, 'chunked ' + url);
    if (url === '/mcp') assert.equal(r.headers['access-control-allow-origin'], '*', 'streamed oversize carries the CORS headers');
  }
  assert.equal((await fetch(base + '/health')).status, 200, 'the server still answers');
});

test('after a 413 the connection is closed once the answer has been sent', T, async (t) => {
  const { port } = await boot(t);
  const result = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = ''; sock.setEncoding('latin1');
    sock.on('data', (x) => { buf += x; });
    sock.on('error', () => {}); // a reset after the answer is fine
    sock.on('close', () => resolve(buf));
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('the server kept the connection open')); });
    sock.write('POST /api/rooms HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ' + (200 * 1024) + '\r\n\r\n{"pad":"' + 'x'.repeat(1000));
  });
  assert.match(result, /^HTTP\/1\.1 413 /);
});

test('the server bounds how long a request may take to arrive', T, async (t) => {
  const { app } = await boot(t);
  assert.equal(app.server.requestTimeout, 30000);
  assert.equal(app.server.headersTimeout, 20000);
});

// ---- security headers on every kind of response ----
test('the exact CSP rides on MCP, 4xx, bad-request, 413 and SSE-refusal responses', T, async (t) => {
  const { port, base } = await boot(t, { overrides: { http: { limits: { anon: 0 } } } });
  const { id, token } = await createDemo(base);
  const check = (get, what) => {
    assert.equal(get('content-security-policy'), CSP, what);
    assert.equal(get('x-content-type-options'), 'nosniff', what);
    assert.equal(get('referrer-policy'), 'no-referrer', what);
  };
  const post = (p, body, extra) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra }, body });
  const cases = [
    ['mcp 200', await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })), 200],
    ['mcp 400', await post('/mcp', '{bad'), 400],
    ['seat 403', await post(`/api/rooms/${id}/seats/A/seal`, JSON.stringify({ token: 'wrong' })), 403],
    ['seat 200', await post(`/api/rooms/${id}/seats/A/seal`, JSON.stringify({ token })), 200],
    ['413', await post('/api/rooms', JSON.stringify({ pad: 'x'.repeat(70 * 1024) })), 413],
    ['404', await fetch(base + '/api/nope'), 404],
  ];
  for (const [what, res, status] of cases) { assert.equal(res.status, status, what); check((h) => res.headers.get(h), what); await res.arrayBuffer(); }
  const line = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let buf = ''; sock.setEncoding('latin1'); sock.on('data', (x) => { buf += x; }); sock.on('error', reject); sock.on('close', () => resolve(buf));
  });
  assert.match(line, /^HTTP\/1\.1 400 /);
  assert.ok(line.includes('content-security-policy: ' + CSP), '400 bad request');
  const refused = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: ev(id) }, resolve).on('error', reject));
  assert.equal(refused.statusCode, 204);
  check((h) => refused.headers[h], '204 refusal');
  assert.equal(refused.headers['cache-control'], 'no-store');
  refused.resume();
});

// ---- client address ----
// POST /api/rooms hands the address to the domain; this fake domain records it.
async function ipSeen(t, trustProxy, xff) {
  const seen = [];
  const created = { id: 'r2', seats: { A: { token: 'a', mode: 'builtin' }, B: { token: 'b', mode: 'builtin' } } };
  const { port } = await fakeWeb(t, () => ({}), { trustProxy, domainExtra: { createLiveRoom: (ip) => { seen.push(ip); return created; } } });
  const headers = { 'content-type': 'application/json' };
  if (xff !== undefined) headers['x-forwarded-for'] = xff;
  const res = await fetch('http://127.0.0.1:' + port + '/api/rooms', { method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 201);
  await res.arrayBuffer();
  return seen[0];
}

test('clientIp: the last X-Forwarded-For entry when trusted, else the socket address', T, async (t) => {
  assert.equal(await ipSeen(t, () => true, '1.1.1.1, 2.2.2.2, 9.9.9.9'), '9.9.9.9');
  assert.equal(await ipSeen(t, () => true, '1.1.1.1, 2.2.2.2'), '2.2.2.2', 'the last, not the first');
  assert.equal(await ipSeen(t, () => true, '1.1.1.1, 2.2.2.2, , '), '2.2.2.2', 'blank entries are ignored');
  assert.equal(await ipSeen(t, () => true, ' 7.7.7.7 '), '7.7.7.7', 'whitespace is trimmed');
  assert.equal(await ipSeen(t, () => true, ' , '), '127.0.0.1', 'only blanks falls back to the socket');
  assert.equal(await ipSeen(t, () => true, ''), '127.0.0.1', 'empty falls back to the socket');
  assert.equal(await ipSeen(t, () => true, undefined), '127.0.0.1', 'no header falls back to the socket');
  assert.equal(await ipSeen(t, () => false, '1.1.1.1, 9.9.9.9'), '127.0.0.1', 'an untrusted header is ignored');
});

test('createHttpServer requires trustProxy', () => {
  const { createHttpServer } = require('../lib/http');
  assert.throws(() => createHttpServer({ domain: { rooms: new Map(), onChange: () => () => {} } }), /trustProxy/);
});

// ---- static routes ----
test('static routes serve the same files as before', T, async (t) => {
  const { base } = await boot(t);
  const HTML = 'text/html; charset=utf-8';
  const table = [
    ['/', 'web/index.html', HTML], ['/start', 'web/start.html', HTML], ['/connect', 'web/connect.html', HTML],
    ['/spec', 'web/spec.html', HTML], ['/ui', 'web/ui/index.html', HTML], ['/ui/', 'web/ui/index.html', HTML],
    ['/room/x', 'web/room.html', HTML], ['/room/', 'web/room.html', HTML], ['/brief/x', 'web/agreement.html', HTML],
    ['/spec/SPEC.md', 'spec/SPEC.md', 'text/markdown; charset=utf-8'],
    ['/ui/ui.css', 'web/ui/ui.css', 'text/css'],
  ];
  for (const [route, file, type] of table) {
    const res = await fetch(base + route);
    assert.equal(res.status, 200, route);
    assert.equal(res.headers.get('content-type'), type, route);
    assert.equal(res.headers.get('cache-control'), 'no-cache', route);
    // the local asset URLs in HTML and CSS carry ?v= (see the caching tests below); without it the bytes are the file's
    assert.equal((await res.text()).replace(/\?v=[0-9a-f]{12}/g, ''), fs.readFileSync(path.join(ROOT, file), 'utf8'), route);
  }
  for (const route of ['/nope', '/spec/', '/spec/nope.md', '/ui/nope', '/roomx']) {
    const res = await fetch(base + route);
    assert.equal(res.status, 404, route);
    await res.arrayBuffer();
  }
});

test('resolveStatic: raw paths that leave the web directory resolve to null', () => {
  const pub = path.join(ROOT, 'web');
  for (const p of ['/../index.js', '/..\\index.js', '/a/../../index.js', '/ui/../../index.js', '/C:/Windows/win.ini', '/index.html::$DATA', '//server/share', '/%2e%2e/x']) {
    if (p === '/%2e%2e/x') { assert.equal(resolveStatic(pub, p), path.join(pub, p.slice(1)), 'an encoded dot segment is just a name'); continue; }
    assert.equal(resolveStatic(pub, p), null, p);
  }
  assert.equal(resolveStatic(pub, '/ui/ui.css'), path.join(pub, 'ui', 'ui.css'));
  assert.equal(resolveStatic(pub, '/'), path.join(pub, 'index.html'));
  assert.equal(resolveStatic(pub, '/a/../ui/ui.css'), path.join(pub, 'ui', 'ui.css'), 'dot segments that stay inside are fine');
});

// ---- static caching: content hashes, ?v= stamps, gzip ----
// A request with exact headers and the raw (still compressed) body: fetch would add its own Accept-Encoding and decode.
function rawGet(base, route, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const sha12 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
const IMMUTABLE = 'private, max-age=31536000, immutable';
const IDENTITY = { 'accept-encoding': 'identity' };

// A root with a tiny web/: a page, a script, a stylesheet that names a font, the font, a logo and a text file.
function staticRoot(t) {
  const root = mkTmp('http-static-');
  t.after(() => rmTmp(root));
  const w = (rel, data) => { fs.mkdirSync(path.dirname(path.join(root, 'web', rel)), { recursive: true }); fs.writeFileSync(path.join(root, 'web', rel), data); };
  w('start.html', '<link rel="stylesheet" href="/ui/ui.css"><script src="/js/a.js" defer></script><img src="/ui/logo.svg">' +
    '<script src="https://cdn.example/x.js"></script><script src="//cdn.example/y.js"></script><script src="/js/a.js?v=old"></script><script src="/js/missing.js"></script>' +
    '<a href="/connect">c</a> <a href="/js/a.js">link text</a> <p>src=&quot;/js/a.js&quot; and <code>src="/js/a.js"</code></p>');
  w('js/a.js', 'console.log("a");\n'.repeat(50));
  w('ui/ui.css', "@font-face{src:url('/ui/f.woff2') format('woff2');}\nbody{background:url(\"/ui/logo.svg\")}\n");
  w('ui/f.woff2', Buffer.from([1, 2, 3, 4]));
  w('ui/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const clock = { t: 1e12, now: () => clock.t }; // the static cache's clock: advance it past the recheck window instead of sleeping
  return { root, w, clock, over: { http: { root, staticNow: clock.now } } };
}
const later = (file) => { const when = new Date(Date.now() + 5000); fs.utimesSync(file, when, when); };

test('static files: a strong ETag on every response, and If-None-Match gets a 304 with no body', T, async (t) => {
  const { base } = await boot(t);
  for (const route of ['/start', '/ui/ui.css', '/js/start.js', '/ui/logo.svg', '/ui/fonts/hanken-grotesk-latin.woff2', '/spec/SPEC.md']) {
    const first = await rawGet(base, route);
    assert.equal(first.status, 200, route);
    const etag = first.headers.etag;
    assert.match(etag, /^"[0-9a-f]{12}"$/, route);
    assert.equal(first.headers.vary, 'accept-encoding', route);
    const again = await rawGet(base, route, { 'if-none-match': etag });
    assert.equal(again.status, 304, route);
    assert.equal(again.body.length, 0, route);
    assert.equal(again.headers.etag, etag, route);
    assert.equal(again.headers['cache-control'], first.headers['cache-control'], route);
    assert.equal((await rawGet(base, route, { 'if-none-match': '"000000000000"' })).status, 200, route + ': another tag');
    assert.equal((await rawGet(base, route, { 'if-none-match': '"000000000000", W/' + etag })).status, 304, route + ': a list');
  }
});

test('static files: the ETag is the hash of the bytes sent, so the HTML\'s is of its stamped bytes', T, async (t) => {
  const { root } = staticRoot(t);
  const { base } = await boot(t, { overrides: { http: { root } } });
  const js = fs.readFileSync(path.join(root, 'web', 'js', 'a.js'));
  assert.equal((await rawGet(base, '/js/a.js')).headers.etag, '"' + sha12(js) + '"');
  const page = await rawGet(base, '/start', IDENTITY);
  assert.equal(page.headers.etag, '"' + sha12(page.body) + '"');
  assert.notEqual(page.body.toString(), fs.readFileSync(path.join(root, 'web', 'start.html'), 'utf8'));
});

test('static HTML: local script, link and img URLs get ?v= with the asset\'s own ETag, and nothing else is touched', T, async (t) => {
  const { root } = staticRoot(t);
  const { base } = await boot(t, { overrides: { http: { root } } });
  const etagOf = async (route) => JSON.parse((await rawGet(base, route)).headers.etag);
  const page = await rawGet(base, '/start', IDENTITY);
  assert.equal(page.headers['cache-control'], 'no-cache', 'the page itself is never cached');
  const html = page.body.toString();
  const css = await etagOf('/ui/ui.css');
  assert.ok(html.includes('<link rel="stylesheet" href="/ui/ui.css?v=' + css + '">'), html);
  assert.ok(html.includes('<script src="/js/a.js?v=' + await etagOf('/js/a.js') + '" defer></script>'));
  assert.ok(html.includes('<img src="/ui/logo.svg?v=' + await etagOf('/ui/logo.svg') + '">'));
  assert.ok(html.includes('<script src="https://cdn.example/x.js"></script>'), 'an absolute URL is left alone');
  assert.ok(html.includes('<script src="//cdn.example/y.js"></script>'), 'a protocol-relative URL is left alone');
  assert.ok(html.includes('<script src="/js/a.js?v=old"></script>'), 'an existing query is left alone');
  assert.ok(html.includes('<script src="/js/missing.js"></script>'), 'a file that does not exist is left alone');
  assert.ok(html.includes('<a href="/connect">c</a>'), 'a page link is left alone');
  assert.ok(html.includes('<a href="/js/a.js">link text</a>'), 'only link, script, img and source tags are stamped');
  assert.ok(html.includes('src=&quot;/js/a.js&quot; and <code>src="/js/a.js"</code>'), 'text is left alone');
});

test('static CSS: the font URL is stamped, the CSS hash covers the stamp, and a changed font re-stamps the CSS and the page', T, async (t) => {
  const { root, w, clock, over } = staticRoot(t);
  const { base } = await boot(t, { overrides: over });
  const font = JSON.parse((await rawGet(base, '/ui/f.woff2')).headers.etag);
  const logo = JSON.parse((await rawGet(base, '/ui/logo.svg')).headers.etag);
  const css = await rawGet(base, '/ui/ui.css', IDENTITY);
  assert.ok(css.body.toString().includes("url('/ui/f.woff2?v=" + font + "')"), css.body.toString());
  assert.ok(css.body.toString().includes('url("/ui/logo.svg?v=' + logo + '")'));
  assert.equal(css.headers.etag, '"' + sha12(css.body) + '"', 'the hash is of the rewritten bytes');
  assert.notEqual(css.headers.etag, '"' + sha12(fs.readFileSync(path.join(root, 'web', 'ui', 'ui.css'))) + '"');
  const page1 = (await rawGet(base, '/start', IDENTITY)).body.toString();
  assert.ok(page1.includes('/ui/ui.css?v=' + JSON.parse(css.headers.etag)));
  // the font changes, the CSS file does not
  w('ui/f.woff2', Buffer.from([9, 9, 9, 9, 9]));
  later(path.join(root, 'web', 'ui', 'f.woff2'));
  clock.t += 1500;
  const css2 = await rawGet(base, '/ui/ui.css', IDENTITY);
  const font2 = JSON.parse((await rawGet(base, '/ui/f.woff2')).headers.etag);
  assert.notEqual(font2, font);
  assert.ok(css2.body.toString().includes("url('/ui/f.woff2?v=" + font2 + "')"), 'the CSS names the new font');
  assert.notEqual(css2.headers.etag, css.headers.etag);
  const page2 = (await rawGet(base, '/start', IDENTITY)).body.toString();
  assert.ok(page2.includes('/ui/ui.css?v=' + JSON.parse(css2.headers.etag)), 'and the page names the new CSS');
  assert.notEqual(page2, page1);
});

test('static assets: a current ?v= is cached for a year as immutable; a stale, empty or missing one is no-cache; HTML never is', T, async (t) => {
  const { base } = await boot(t);
  const tag = JSON.parse((await rawGet(base, '/js/start.js')).headers.etag);
  assert.equal((await rawGet(base, '/js/start.js')).headers['cache-control'], 'no-cache');
  assert.equal((await rawGet(base, '/js/start.js?v=' + tag)).headers['cache-control'], IMMUTABLE);
  for (const q of ['?v=000000000000', '?v=', '?x=' + tag, '?V=' + tag]) assert.equal((await rawGet(base, '/js/start.js' + q)).headers['cache-control'], 'no-cache', q);
  assert.equal((await rawGet(base, '/js/start.js?x=1&v=' + tag)).headers['cache-control'], IMMUTABLE, 'other parameters are ignored');
  assert.equal((await rawGet(base, '/js/start.js?v=' + tag, { 'if-none-match': '"' + tag + '"' })).headers['cache-control'], IMMUTABLE, 'also on a 304');
  const htmlTag = JSON.parse((await rawGet(base, '/start')).headers.etag);
  assert.equal((await rawGet(base, '/start?v=' + htmlTag)).headers['cache-control'], 'no-cache');
});

test('static assets: every local asset URL the real pages carry resolves to a file and is stamped with its current hash', T, async (t) => {
  const { base } = await boot(t);
  for (const route of ['/', '/start', '/connect', '/spec', '/ui', '/room/x', '/brief/x']) {
    const html = (await rawGet(base, route, IDENTITY)).body.toString();
    const urls = [...html.matchAll(/<(?:link|script|img)\b[^>]*?\s(?:src|href)=(["'])(\/[^"'?]*\.(?:js|css|svg))(\?[^"']*)?\1/g)].map((m) => [m[0], m[2], m[3]]);
    assert.ok(urls.length >= 3, route);
    for (const [, url, query] of urls) {
      const asset = await rawGet(base, url);
      assert.equal(asset.status, 200, route + ' ' + url);
      assert.equal(query, '?v=' + JSON.parse(asset.headers.etag), route + ' ' + url);
    }
  }
});

test('static files: gzip when it is accepted (same bytes once decoded), identity when it is not, and never for fonts', T, async (t) => {
  const { base } = await boot(t);
  for (const route of ['/start', '/ui/ui.css', '/js/start.js', '/ui/logo.svg', '/spec/SPEC.md']) {
    const plain = await rawGet(base, route, IDENTITY);
    assert.equal(plain.headers['content-encoding'], undefined, route);
    assert.equal(plain.headers['content-length'], String(plain.body.length), route);
    assert.equal((await rawGet(base, route)).headers['content-encoding'], undefined, route + ': no header, no gzip');
    const zipped = await rawGet(base, route, { 'accept-encoding': 'br, GZIP;q=0.8' });
    assert.equal(zipped.headers['content-encoding'], 'gzip', route);
    assert.equal(zipped.headers.vary, 'accept-encoding', route);
    assert.equal(zipped.headers['content-length'], String(zipped.body.length), route);
    assert.ok(zipped.body.length < plain.body.length, route + ': smaller');
    assert.deepEqual(require('node:zlib').gunzipSync(zipped.body), plain.body, route);
    assert.equal(zipped.headers.etag, plain.headers.etag.replace(/"$/, '-gz"'), route + ': one ETag per coding');
    // A 304 only vouches for the coding that would be sent: the identity ETag on a gzip request gets the bytes again.
    assert.equal((await rawGet(base, route, { 'accept-encoding': 'gzip', 'if-none-match': plain.headers.etag })).status, 200, route + ': the other coding\'s ETag does not match');
    assert.equal((await rawGet(base, route, { ...IDENTITY, 'if-none-match': plain.headers.etag })).status, 304, route + ': its own coding matches');
    assert.equal((await rawGet(base, route, { 'accept-encoding': 'gzip', 'if-none-match': zipped.headers.etag })).status, 304, route);
    assert.equal((await rawGet(base, route, { 'accept-encoding': 'gzip', 'if-none-match': 'W/' + zipped.headers.etag })).status, 304, route + ': weak');
    assert.equal(zipped.headers['content-type'], plain.headers['content-type'], route);
    assert.equal((await rawGet(base, route, { 'accept-encoding': 'gzip;q=0' })).headers['content-encoding'], undefined, route + ': q=0 refuses it');
  }
  const font = await rawGet(base, '/ui/fonts/hanken-grotesk-latin.woff2', { 'accept-encoding': 'gzip' });
  assert.equal(font.headers['content-encoding'], undefined);
  assert.equal(font.headers.vary, 'accept-encoding');
  assert.deepEqual(font.body, fs.readFileSync(path.join(ROOT, 'web', 'ui', 'fonts', 'hanken-grotesk-latin.woff2')));
});

test('static files: the security headers stay on 200 and 304, and a file that changes is served anew', T, async (t) => {
  const { root, w, clock, over } = staticRoot(t);
  const { base } = await boot(t, { overrides: over });
  const tag = (await rawGet(base, '/js/a.js')).headers.etag;
  for (const route of ['/start', '/js/a.js', '/js/a.js?v=whatever']) {
    for (const res of [await rawGet(base, route), await rawGet(base, route, { 'if-none-match': tag })]) {
      assert.equal(res.headers['content-security-policy'], CSP, route);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', route);
      assert.equal(res.headers['referrer-policy'], 'no-referrer', route);
    }
  }
  assert.equal((await rawGet(base, '/js/a.js')).headers['content-type'], 'text/javascript');
  w('js/a.js', 'changed\n');
  later(path.join(root, 'web', 'js', 'a.js'));
  assert.equal((await rawGet(base, '/js/a.js')).headers.etag, tag, 'inside the recheck window the entry is not even looked at');
  clock.t += 1500;
  const after = await rawGet(base, '/js/a.js', { 'if-none-match': tag });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.etag, tag);
  assert.ok((await rawGet(base, '/start', IDENTITY)).body.toString().includes('/js/a.js?v=' + JSON.parse(after.headers.etag)), 'the page stamps the new hash');
  for (const route of ['/nope', '/js/', '/js']) {
    const res = await rawGet(base, route);
    assert.equal(res.status, 404, route);
    assert.equal(res.headers.etag, undefined, route);
  }
});

// ---- drain ----
test('drain writes pending changes, ends the streams, is idempotent and resolves true', T, async (t) => {
  const { app, port, base, file, d } = await boot(t);
  const { id } = await createDemo(base);
  const c = openStream(port, ev(id));
  await c.ready;
  assert.ok(!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes(id), 'the debounced save has not run yet');
  assert.equal(await app.drain(), true);
  assert.ok(fs.readFileSync(file, 'utf8').includes(id), 'the room is on disk once drain has resolved');
  await waitFor(() => c.closed, (v) => v === true, { what: 'the stream to be ended' });
  assert.equal(d.streamCount(id), 0);
  assert.equal(app.server.listening, false);
  assert.equal(await app.drain(), true);
});

test('drain resolves false when the write fails', T, async (t) => {
  const { app, dir } = await boot(t);
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'data'), 'now a file, so the directory cannot be recreated');
  assert.equal(await app.drain(), false);
});

test('after drain a running demo takes no further turn', T, async (t) => {
  const { app } = await boot(t, { overrides: { clock: { sleep: () => sleep(150) } } });
  const room = app.domain.createDemoRoom();
  app.domain.sealCard(room, 'A', room.seats.A.card, 'web');
  app.domain.sealCard(room, 'B', room.seats.B.card, 'web');
  await waitFor(() => room.envelopes.length, (n) => n >= 1, { intervalMs: 5, what: 'the demo to start' });
  assert.equal(room.status, 'negotiating', 'more turns are still to come');
  await app.drain();
  await sleep(30); // a turn already past its stop check may finish
  const n = room.envelopes.length;
  await sleep(500);
  assert.equal(room.envelopes.length, n);
  assert.equal(room.status, 'negotiating');
});

// ---- build fingerprint ----
// The algorithm as it was in index.js before it moved, rooted at the repository.
function oldBuild() {
  const h = crypto.createHash('sha256');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && !(d === ROOT && e.name === 'docs'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else h.update(path.relative(ROOT, p) + '\0').update(fs.readFileSync(p)); });
  walk(ROOT);
  return h.digest('hex').slice(0, 12);
}

test('/health build equals the fingerprint of the repository tree', T, async (t) => {
  const { base } = await boot(t);
  const j = await (await fetch(base + '/health')).json();
  assert.match(j.build, /^[0-9a-f]{12}$/);
  assert.equal(j.build, oldBuild());
});

test('the build and the static files come from the root the server was given, not the repository', T, async (t) => {
  const root = mkTmp('http-root-');
  t.after(() => rmTmp(root));
  fs.mkdirSync(path.join(root, 'web'));
  fs.writeFileSync(path.join(root, 'web', 'only-here.txt'), 'one');
  const { base } = await boot(t, { overrides: { http: { root } } });
  const first = (await (await fetch(base + '/health')).json()).build;
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.notEqual(first, oldBuild(), 'the fingerprint is of the given tree');
  const res = await fetch(base + '/only-here.txt');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'one');
  assert.equal((await fetch(base + '/ui/ui.css')).status, 404, 'the repository web/ is not served');
});

async function buildOf(dir) {
  const data = mkTmp('build-data-');
  const s = await start(path.join(dir, 'index.js'), { PORT: '0', BIND_HOST: '127.0.0.1', SIGNIN: 'off', DROP_DATA_DIR: data });
  try {
    assert.strictEqual(s.exited, undefined, 'server exited: ' + s.out);
    return (await (await fetch(`http://127.0.0.1:${s.port}/health`)).json()).build;
  } finally {
    await s.stop();
    rmTmp(data);
  }
}

test('a web/ change alters the build and a docs/ change does not', T, async () => {
  const variants = [{}, { 'web/x': 'one' }, { 'web/x': 'two, changed' }, { 'docs/plan.md': 'one' }];
  const dirs = variants.map(makeSrc);
  try {
    const [base, web1, web2, docs] = await Promise.all(dirs.map(buildOf));
    assert.notStrictEqual(web1, base, 'web/x did not change the build');
    assert.notStrictEqual(web2, web1, 'a web/x edit did not change the build');
    assert.strictEqual(docs, base, 'docs/ changed the build');
  } finally {
    dirs.forEach(rmTmp);
  }
});

// ---- signals ----
// Spawn index.js, make a room, then end it by `how`; resolves the exit and the room id.
async function spawnAndStop(prefix, how, { args = [], env = {} } = {}) {
  const dir = mkTmp(prefix);
  const child = spawn(process.execPath, [...args, path.join(ROOT, 'index.js')], { env: baseEnv({ PORT: '0', BIND_HOST: '127.0.0.1', SIGNIN: 'off', DROP_DATA_DIR: dir, ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    const port = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; const m = /on :(\d+) /.exec(out); if (m) resolve(Number(m[1])); });
      child.once('close', () => reject(new Error('exited before listening: ' + out)));
    });
    const { id } = await (await fetch(`http://127.0.0.1:${port}/api/demo`, { method: 'POST' })).json();
    how(child, dir);
    const r = await exited;
    let saved = null;
    try { saved = fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8'); } catch (e) { /* the store could not be written */ }
    return { ...r, id, saved };
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmTmp(dir);
  }
}

const PRELOAD = ['-r', path.join(ROOT, 'test-support', 'sigterm-preload.js')];
// Every-OS signal runs: the preload raises the signal inside the process once a trigger file appears.
async function signalInProcess(name, { breakStore = false } = {}) {
  const trigger = path.join(mkTmp('trigger-'), 'go');
  try {
    return await spawnAndStop('signal-' + name.toLowerCase() + '-', (child, dir) => {
      if (breakStore) { fs.rmSync(dir, { recursive: true, force: true }); fs.writeFileSync(dir, 'now a file, so the data directory cannot be written'); }
      fs.writeFileSync(trigger, '');
    }, { args: PRELOAD, env: { SIGTERM_TRIGGER: trigger, SIGNAL_NAME: name } });
  } finally { rmTmp(path.dirname(trigger)); }
}

test('SIGTERM handler (raised in-process, every OS) flushes the store and exits 0', T, async () => {
  const r = await signalInProcess('SIGTERM');
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 0, signal: null });
  assert.ok(r.saved.includes(r.id), 'the room was written before exit');
});

test('SIGINT handler (raised in-process, every OS) flushes the store and exits 130', T, async () => {
  const r = await signalInProcess('SIGINT');
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 130, signal: null });
  assert.ok(r.saved.includes(r.id), 'the room was written before exit');
});

test('SIGTERM exits 1 when the final write fails', T, async () => {
  const r = await signalInProcess('SIGTERM', { breakStore: true });
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 1, signal: null });
});

test('a real SIGTERM flushes the store and exits 0', { ...T, skip: process.platform === 'win32' }, async () => {
  const r = await spawnAndStop('sigterm-', (child) => child.kill('SIGTERM')); // well inside the 300 ms save delay
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 0, signal: null });
  assert.ok(r.saved.includes(r.id), 'the room was written before exit');
});

test('a real SIGINT flushes the store and exits 130', { ...T, skip: process.platform === 'win32' }, async () => {
  const r = await spawnAndStop('sigint-', (child) => child.kill('SIGINT'));
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 130, signal: null });
  assert.ok(r.saved.includes(r.id), 'the room was written before exit');
});

test('drain still writes the store when stopping the turn loop throws, and a second call reports the same outcome', T, async (t) => {
  const { app, file, base } = await boot(t);
  const { id } = await createDemo(base);
  const stop = app.domain.stop;
  app.domain.stop = () => { throw new Error('stop failed'); };
  await assert.rejects(app.drain(), /stop failed/);
  app.domain.stop = stop; // the cleanup stops the domain again
  assert.ok(fs.readFileSync(file, 'utf8').includes(id), 'the room reached the disk anyway');
  await assert.rejects(app.drain(), /stop failed/, 'a second call is the same outcome');
});

test('SSE limits: demo seats count against globalAnon, live seats use the headroom', T, async (t) => {
  const { port, rooms, d } = await fakeWeb(t, () => ({}), { limits: { globalAnon: 2, global: 4 } });
  for (const id of ['d1', 'd2', 'd3']) rooms.set(id, { id, demo: true, seats: { A: { token: 'ta' }, B: { token: 'tb' } } });
  const s1 = openStream(port, ev('d1', seatQ('A', 'ta'))); await s1.ready;
  const s2 = openStream(port, ev('d2', seatQ('A', 'ta'))); await s2.ready;
  assert.equal(s1.status, 200); assert.equal(s2.status, 200);
  const refused = openStream(port, ev('d3', seatQ('A', 'ta'))); await refused.ready;
  assert.equal(refused.status, 204, 'a third demo seat stream is refused: the demo token is free');
  const live = openStream(port, ev('r1', seatQ('A', 'ta'))); await live.ready;
  assert.equal(live.status, 200, 'a live-room seat stream still gets the headroom');
  s1.drop();
  await waitFor(() => d.streamCount('d1'), (n) => n === 0);
  const again = openStream(port, ev('d3', seatQ('A', 'ta'))); await again.ready;
  assert.equal(again.status, 200, 'a demo place frees up when a demo stream closes');
  [s2, live, again].forEach((c) => c.drop());
});

test('the 204 refusal carries cache-control: no-store', T, async (t) => {
  const { port } = await fakeWeb(t, () => ({}), { limits: { anon: 0 } });
  const res = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: ev('r1') }, resolve).on('error', reject));
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['cache-control'], 'no-store');
  res.resume();
});
