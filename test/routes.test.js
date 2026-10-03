'use strict';
// The page routes serve their HTML with the security headers every response carries, the right
// title and their own page script.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ROOT } = require('../test-support/paths');
const { start, mkTmp, rmTmp } = require('../test-support/server');

const ROUTES = [
  { url: '/start', title: /<title>Start a room · Behalf<\/title>/, script: '/js/start.js' },
  { url: '/brief/x', title: /<title>Agreement · Behalf<\/title>/, script: '/js/agreement.js' },
  { url: '/connect', title: /<title>Use your own AI agent · Behalf<\/title>/, script: '/js/connect.js' },
  { url: '/spec', title: /<title>The protocol · Behalf<\/title>/, script: '/js/protocol.js' },
];

let server = null;
let dir = null;

before(async () => {
  dir = mkTmp('routes-');
  server = await start(path.join(ROOT, 'index.js'), { PORT: '0', BIND_HOST: '127.0.0.1', SIGNIN: 'off', DROP_DATA_DIR: dir });
  assert.strictEqual(server.exited, undefined, 'server exited: ' + server.out);
});

after(async () => {
  if (server) await server.stop();
  if (dir) rmTmp(dir);
});

for (const r of ROUTES) {
  test(`GET ${r.url} serves its page as HTML with the CSP`, async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}${r.url}`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const body = await res.text();
    assert.match(body, r.title);
    assert.ok(body.includes(`src="${r.script}"`), 'loads ' + r.script);
  });
}
