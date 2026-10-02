'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { ROOT } = require('../test-support/paths');
const { start, mkTmp, rmTmp } = require('../test-support/server');

let server = null;
let dir = null;
let base = '';
let port = 0;

before(async () => {
  dir = mkTmp('ui-test-');
  server = await start(path.join(ROOT, 'index.js'), { PORT: '0', BIND_HOST: '127.0.0.1', DROP_DATA_DIR: dir });
  assert.strictEqual(server.exited, undefined, 'server exited early with code ' + server.exited + '. Output:\n' + server.out);
  port = server.port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await server.stop();
  if (dir) rmTmp(dir);
});

// get(name) reads a response header, so fetch's Headers and node's plain object share one check.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function checkHeaders(get) {
  assert.strictEqual(get('referrer-policy'), 'no-referrer');
  assert.strictEqual(get('x-content-type-options'), 'nosniff');
  assert.strictEqual(get('content-security-policy'), CSP);
}

const routes = [
  ['/ui', 'text/html'],
  ['/ui/', 'text/html'],
  ['/ui/ui.css', 'text/css'],
  ['/ui/ui.js', 'text/javascript'],
  ['/ui/theme.js', 'text/javascript'],
  ['/ui/fonts/hanken-grotesk-latin.woff2', 'font/woff2'],
  ['/ui/logo.svg', 'image/svg+xml'],
  ['/ui/guide.css', 'text/css'],
  ['/ui/guide.js', 'text/javascript'],
  ['/ui/fonts/OFL.txt', 'text/plain; charset=utf-8'],
  ['/health', 'application/json'],
];
for (const [route, type] of routes) {
  test(`GET ${route} is 200 ${type} with security headers`, async () => {
    const res = await fetch(base + route);
    assert.strictEqual(res.status, 200, `status for ${route}`);
    assert.ok((res.headers.get('content-type') || '').startsWith(type), 'content-type was ' + res.headers.get('content-type'));
    checkHeaders((h) => res.headers.get(h));
    await res.arrayBuffer();
  });
}

test('every page and the JSON API carry the exact CSP', async () => {
  for (const route of ['/', '/start', '/room/x', '/brief/x', '/connect', '/spec', '/ui', '/api/config', '/spec/SPEC.md']) {
    const res = await fetch(base + route);
    assert.strictEqual(res.status, 200, route);
    checkHeaders((h) => res.headers.get(h));
    await res.arrayBuffer();
  }
});

// Headers are set before routing, so error responses and MCP's own writeHead carry the policy too.
test('error responses and MCP non-POST responses carry the exact CSP', async () => {
  for (const [route, method, status] of [['/nope.js', 'GET', 404], ['/mcp', 'GET', 405]]) {
    const res = await fetch(base + route, { method });
    assert.strictEqual(res.status, status, route);
    checkHeaders((h) => res.headers.get(h));
    await res.arrayBuffer();
  }
});

test('served HTML refuses to be framed', async () => {
  for (const route of ['/ui', '/']) {
    const res = await fetch(base + route);
    assert.ok((res.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"), route);
    await res.arrayBuffer();
  }
});

test('SSE stream keeps its security headers', async () => {
  const demo = await (await fetch(base + '/api/demo', { method: 'POST' })).json();
  assert.ok(demo.id, 'demo room was not created');
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/rooms/${demo.id}/events` }, resolve);
    req.on('error', reject);
    req.end();
  });
  try {
    assert.strictEqual(res.statusCode, 200);
    assert.ok(String(res.headers['content-type']).startsWith('text/event-stream'));
    checkHeaders((h) => res.headers[h]);
  } finally {
    res.destroy();
  }
});

test('/health reports ok', async () => {
  const j = await (await fetch(base + '/health')).json();
  assert.strictEqual(j.ok, true);
});

// ---- path traversal ----
const MARKER = "require('./lib/pxp')";
const leaks = (r) => r.status === 200 && r.body.includes(MARKER);

// [path, sent by fetch, sent raw]. fetch normalises dot segments, so the raw http request is
// the only way to put an un-normalised path on the wire.
const TRAVERSAL = [
  ['/../index.js', true, true],
  ['/..%2findex.js', true, false],
  ['/ui/../../index.js', true, true],
  ['/ui/..%2f..%2findex.js', true, false],
  ['/%2e%2e/index.js', false, true],
  ['/ui/%2e%2e/%2e%2e/index.js', false, true],
  // Raw backslash traversal: the doubled backslash is a real "\" in the request path.
  ['/..\\index.js', false, true],
  ['/ui/..\\..\\index.js', false, true],
];

async function fetchGet(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.text() };
}

function rawGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('traversal via fetch does not serve index.js source', async () => {
  for (const [p] of TRAVERSAL.filter((t) => t[1])) {
    const r = await fetchGet(p);
    assert.ok(!leaks(r), `${p} leaked source (status ${r.status})`);
  }
});

test('traversal via raw un-normalised request does not serve index.js source', async () => {
  for (const [p] of TRAVERSAL.filter((t) => t[2])) {
    const r = await rawGet(p);
    assert.ok(!leaks(r), `${p} leaked source (status ${r.status})`);
  }
});

test('POST /mcp carries nosniff and no-referrer', async () => {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.ok(res.status < 500, 'status ' + res.status);
  checkHeaders((h) => res.headers.get(h));
  await res.arrayBuffer();
});

// Send bytes as-is, so a request target that fetch or http.request would reject reaches the server.
function rawStatusLine(request) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(request));
    let buf = '';
    sock.setEncoding('latin1');
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('no response to ' + JSON.stringify(request))); });
    sock.on('data', (d) => {
      buf += d;
      if (buf.includes('\r\n')) { sock.destroy(); resolve(buf.split('\r\n')[0]); }
    });
    sock.on('error', reject);
    sock.on('close', () => resolve(buf.split('\r\n')[0]));
  });
}

test('request targets that new URL rejects get 400 and do not crash the server', async () => {
  for (const target of ['//', '//a:b']) {
    const line = await rawStatusLine(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    assert.match(line, /^HTTP\/1\.1 400 /, `status line for ${target}: ${line}`);
  }
  const j = await (await fetch(base + '/health')).json();
  assert.strictEqual(j.ok, true, 'server stopped answering after the bad targets');
});
