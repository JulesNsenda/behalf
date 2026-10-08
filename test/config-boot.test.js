'use strict';
// A bad strict setting stops the real server at boot: non-zero exit, one app.init_failed line that names the
// variable through its code, and the value itself appears nowhere in the output.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { start, spawnIndex, mkTmp, rmTmp } = require('../test-support/server');
const { ROOT } = require('../test-support/paths');

test('an invalid MAX_ROOMS stops startup with app.init_failed and never echoes the value', { timeout: 20000 }, async (t) => {
  const dir = mkTmp('config-boot-');
  t.after(() => rmTmp(dir));
  const MARKER = 'zq9MARKER' + Date.now();
  const r = await start(path.join(ROOT, 'index.js'), { PORT: '0', BIND_HOST: '127.0.0.1', SIGNIN: 'off', DROP_DATA_DIR: dir, MAX_ROOMS: MARKER });
  await r.stop();
  assert.ok(r.exited !== undefined && r.exited !== 0, 'expected a non-zero exit\n' + r.out);
  const lines = r.out.split('\n').filter((l) => l.includes('event="app.init_failed"'));
  assert.equal(lines.length, 1, r.out);
  assert.ok(lines[0].includes('code="BAD_MAX_ROOMS"'), lines[0]);
  assert.equal(r.out.includes(MARKER), false, 'the value must not be echoed');
});

test('REQUIRE_DATABASE=1 without DATABASE_URL exits 1 at once with BAD_REQUIRE_DATABASE and never binds the port', { timeout: 20000 }, async (t) => {
  const dir = mkTmp('require-db-');
  t.after(() => rmTmp(dir));
  const s = spawnIndex(dir, { REQUIRE_DATABASE: '1' }, [], 8000);
  const r = await s.exited;
  assert.equal(r.code, 1, r.out);
  assert.equal(r.stdout, '', 'no listen line, and no placeholder bound: ' + r.out);
  const lines = r.out.split('\n').filter((l) => l.includes('event="app.init_failed"'));
  assert.equal(lines.length, 1, r.out);
  assert.ok(lines[0].includes('code="BAD_REQUIRE_DATABASE"'), lines[0]);
  assert.ok(!r.out.includes('app.listen_failed') && !fs.existsSync(path.join(dir, 'rooms.json')), 'it did not start: ' + r.out);
});

test('on the platform (DROP_DATA_DIR set) the guard is on by default: REQUIRE_DATABASE unset without DATABASE_URL exits 1 with BAD_REQUIRE_DATABASE', { timeout: 20000 }, async (t) => {
  const dir = mkTmp('require-db-default-');
  t.after(() => rmTmp(dir));
  const s = spawnIndex(dir, { REQUIRE_DATABASE: undefined }, [], 8000);
  const r = await s.exited;
  assert.equal(r.code, 1, r.out);
  assert.equal(r.stdout, '', 'no listen line, and no placeholder bound: ' + r.out);
  assert.ok(r.out.includes('event="app.init_failed"') && r.out.includes('code="BAD_REQUIRE_DATABASE"'), r.out);
  assert.ok(!fs.existsSync(path.join(dir, 'rooms.json')), 'it did not start: ' + r.out);
});

test('REQUIRE_DATABASE=0 still serves from the file store on the platform', { timeout: 20000 }, async (t) => {
  const dir = mkTmp('require-db-off-');
  t.after(() => rmTmp(dir));
  const r = await start(path.join(ROOT, 'index.js'), { PORT: '0', BIND_HOST: '127.0.0.1', SIGNIN: 'off', DROP_DATA_DIR: dir, REQUIRE_DATABASE: '0' });
  try {
    assert.ok(r.port, 'expected a listening server\n' + r.out);
    assert.equal((await fetch(`http://127.0.0.1:${r.port}/health`)).status, 200);
  } finally { await r.stop(); }
});
