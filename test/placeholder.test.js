'use strict';
// index.js's boot placeholder: the port answers 503 "starting" until the app has loaded (a redeploy's new instance has to answer HTTP
// while the old one still holds the database). The two-instance Postgres version is in store-pg.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmp, rmTmp, spawnIndex } = require('../test-support/server');
const { waitFor } = require('../test-support/http');
const { ROOT } = require('../test-support/paths');

const T = { timeout: 30000 };
const PRELOAD = ['-r', path.join(ROOT, 'test-support', 'slow-boot-preload.js')];
const SIG = ['-r', path.join(ROOT, 'test-support', 'sigterm-preload.js')];
const PORT = '47' + String(Math.floor(Math.random() * 900) + 100); // a fixed port both phases share, so the test can find the placeholder

test('during a slow boot the port answers 503 "starting" and the listen line comes later, from the real server', T, async (t) => {
  const dir = mkTmp('placeholder-');
  t.after(() => rmTmp(dir));
  const p = spawnIndex(dir, { PORT, BOOT_DELAY_MS: '1500' }, PRELOAD);
  t.after(() => p.stop());
  const base = `http://127.0.0.1:${PORT}`;
  const res = await waitFor(async () => { try { return await fetch(base + '/api/rooms/x'); } catch (e) { return null; } }, (r) => r !== null);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '5');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await res.json(), { error: 'Behalf is starting. Try again in a moment.', code: 'starting' });
  const h = await fetch(base + '/health');
  assert.equal(h.status, 503);
  assert.deepEqual(await h.json(), { ok: false, starting: true });
  assert.equal(p.stdout(), '', 'the placeholder prints nothing');
  const port = await p.listening;
  assert.equal(String(port), PORT, 'the real server took the same port');
  assert.match(p.stdout().split('\n')[0], /^Behalf \(PXP\/0\) on :\d+ /);
  const ok = await fetch(base + '/health');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
});

test('a boot failure still exits 1 with store.load_failed', T, async (t) => {
  const dir = mkTmp('placeholder-fail-');
  t.after(() => rmTmp(dir));
  const p = spawnIndex(dir, { BOOT_DELAY_MS: '200', BOOT_FAIL: '1' }, PRELOAD);
  const r = await p.exited;
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /event="store\.load_failed"/);
  assert.equal(r.stdout, '');
});

test('SIGTERM during boot exits promptly with 0, and SIGINT with 130', T, async (t) => {
  for (const [name, code] of [['SIGTERM', 0], ['SIGINT', 130]]) {
    const dir = mkTmp('placeholder-sig-');
    const trigger = path.join(mkTmp('placeholder-trigger-'), 'go');
    t.after(() => { rmTmp(dir); rmTmp(path.dirname(trigger)); });
    const p = spawnIndex(dir, { BOOT_DELAY_MS: '20000', SIGTERM_TRIGGER: trigger, SIGNAL_NAME: name }, [...PRELOAD, ...SIG]);
    await new Promise((r) => setTimeout(r, 500));
    const started = Date.now();
    fs.writeFileSync(trigger, '');
    const r = await p.exited;
    assert.equal(r.code, code, r.out);
    assert.ok(Date.now() - started < 3000);
  }
});

test('a port that is taken still ends in app.listen_failed and exit 1', T, async (t) => {
  const net = require('node:net');
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  t.after(() => srv.close());
  const dir = mkTmp('placeholder-busy-');
  t.after(() => rmTmp(dir));
  const p = spawnIndex(dir, { PORT: String(srv.address().port) });
  const r = await p.exited;
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /event="app\.listen_failed"/);
});
