'use strict';
// A bad strict setting stops the real server at boot: non-zero exit, one app.init_failed line that names the
// variable through its code, and the value itself appears nowhere in the output.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { start, mkTmp, rmTmp } = require('../test-support/server');
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
