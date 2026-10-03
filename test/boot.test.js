'use strict';
// bootApp and drain with the file store (no database, no pg), the 60 s write-failure guard on room creation, and what index.js
// does with a crash. The Postgres paths are in store-pg.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, bootApp } = require('../lib/app');
const { createStore, StoreError } = require('../lib/store');
const { loadConfig, loadSecrets } = require('../lib/config');
const { ROOT } = require('../test-support/paths');
const { mkTmp, rmTmp, spawnIndex } = require('../test-support/server');
const { fakeProxy, quietLog } = require('../test-support/app');

const T = { timeout: 30000 };

function setup(t) {
  const dir = mkTmp('boot-');
  t.after(() => rmTmp(dir));
  const config = loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: path.join(dir, 'data'), PUBLIC_URL: 'http://test.invalid' });
  return { dir, file: path.join(dir, 'data', 'rooms.json'), config };
}

// Saves the named variables, and restores them when the test ends.
function guardEnv(t, names) {
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  t.after(() => { for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
}

test('bootApp reads the secrets once, deletes every secret from process.env, and builds the file store without loading pg', T, async (t) => {
  const NAMES = ['ROOM_PASSCODE', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'];
  guardEnv(t, NAMES);
  process.env.ROOM_PASSCODE = 'pw-1'; process.env.ANTHROPIC_API_KEY = 'sk-ant-BOOT-1'; delete process.env.DATABASE_URL;
  process.env.GITHUB_CLIENT_ID = 'gh-id-1'; process.env.GITHUB_CLIENT_SECRET = 'gh-secret-1';
  const { config } = setup(t);
  const app = await bootApp({ config, log: quietLog(), proxy: fakeProxy(), clock: { sleep: async () => {} } });
  t.after(() => app.close());
  for (const k of NAMES) assert.equal(k in process.env, false, k);
  assert.equal(app.ops.passcodeRequired(), true, 'the passcode was read before it was deleted');
  assert.equal(app.store.kind, 'file');
  assert.ok(app.store.health().ok);
  assert.ok(!Object.keys(require.cache).some((p) => /node_modules[\/]pg[\/]/.test(p)), 'pg was loaded for the file store');
});

test('bootApp deletes DATABASE_URL too when a store is passed in, and uses that store as it is', T, async (t) => {
  guardEnv(t, ['DATABASE_URL']);
  process.env.DATABASE_URL = 'postgres://u:secret-pw@127.0.0.1:1/x';
  const { config, file } = setup(t);
  const store = createStore({ file, log: quietLog() });
  store.load();
  const app = await bootApp({ config, log: quietLog(), proxy: fakeProxy(), store });
  t.after(() => app.close());
  assert.equal('DATABASE_URL' in process.env, false);
  assert.equal(app.store, store);
});

test('bootApp does not delete anything from process.env when secrets are passed in', T, async (t) => {
  guardEnv(t, ['ROOM_PASSCODE']);
  process.env.ROOM_PASSCODE = 'kept';
  const { config } = setup(t);
  const app = await bootApp({ config, secrets: loadSecrets({}), log: quietLog(), proxy: fakeProxy() });
  t.after(() => app.close());
  assert.equal(process.env.ROOM_PASSCODE, 'kept');
});

test('bootApp rejects with the StoreError of a store that cannot load, and never exits', T, async (t) => {
  const { config, file } = setup(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"schemaVersion":99,"rooms":{},"usage":{}}');
  await assert.rejects(bootApp({ config, secrets: loadSecrets({}), log: quietLog(), proxy: fakeProxy() }), (e) => e instanceof StoreError && e.code === 'EFUTURESCHEMA');
});

test('/health says which store and whether it is ok', T, async (t) => {
  const { config } = setup(t);
  const app = await bootApp({ config, secrets: loadSecrets({}), log: quietLog(), proxy: fakeProxy() });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.server.closeAllConnections(); app.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let j = await (await fetch(base + '/health')).json();
  assert.equal(j.store, 'file');
  assert.equal(j.storeOk, true);
  app.store.health = () => ({ ok: false, failingSince: 1 });
  j = await (await fetch(base + '/health')).json();
  assert.equal(j.storeOk, false);
  assert.equal(j.ok, true, 'a failing store does not fail the health check: a restart would only lose the memory');
});

test('drain stops the domain and the web layer, writes the store, closes it, and returns the same promise twice', T, async (t) => {
  const { config, file } = setup(t);
  const app = await bootApp({ config, secrets: loadSecrets({}), log: quietLog(), proxy: fakeProxy(), clock: { sleep: async () => {} } });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const room = app.domain.createDemoRoom();
  const p = app.drain();
  assert.equal(app.drain(), p, 'a second call (the other signal) is the same drain');
  assert.equal(await p, true);
  assert.ok(fs.readFileSync(file, 'utf8').includes(room.id), 'the pending room is on disk');
  assert.equal(app.server.listening, false);
  assert.equal(await app.store.persist('room', room.id), false, 'the store is closed');
});

test('drain resolves false when the final write fails, and still closes the store', T, async (t) => {
  const { config, dir } = setup(t);
  const app = await bootApp({ config, secrets: loadSecrets({}), log: quietLog(), proxy: fakeProxy() });
  app.domain.createDemoRoom();
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'data'), 'now a file, so the directory cannot be recreated');
  assert.equal(await app.drain(), false);
  assert.equal(await app.store.persist('room', 'x'), false);
});

// ---- the 60 s write-failure guard ----
const SAVING = 'Saving is unavailable right now. Try again in a minute.';
function guarded(t, failingSince, at = 1700000000000) {
  const { config, file } = setup(t);
  const store = createStore({ file, log: quietLog() });
  store.load();
  store.health = () => ({ ok: failingSince === null, failingSince });
  const app = createApp({ config, secrets: loadSecrets({}), log: quietLog(), proxy: fakeProxy(), store, clock: { now: () => at, sleep: async () => {} } });
  t.after(() => app.close());
  return app;
}
const live = (app) => app.domain.createLiveRoom('1.2.3.4', { topic: 'T', modeA: 'external', modeB: 'external' });
const AT = 1700000000000;

test('room creation is refused with a 503 once writes have been failing for more than 60 s, and uses no quota', T, async (t) => {
  const app = guarded(t, AT - 60001);
  assert.throws(() => live(app), (e) => e.code === 503 && e.message === SAVING);
  assert.equal(app.domain.rooms.size, 0);
  assert.equal(app.store.state.usage.total, 0, 'the refused request took no quota');
});

test('room creation still works with no failure, or one of 60 s or less', T, async (t) => {
  for (const since of [null, AT, AT - 30000, AT - 60000]) {
    const app = guarded(t, since);
    assert.equal(live(app).demo, false, String(since));
  }
});

test('the guard reads the injected clock, not the real one', T, async (t) => {
  const app = guarded(t, 1000, 1000 + 61000);
  assert.throws(() => live(app), /Saving is unavailable/);
  const young = guarded(t, Date.now() - 61000, 1000 + 61000); // a real-clock reading would call this stale; the injected one does not
  assert.ok(live(young).id);
});

test('the demo is not refused while saving fails: it is not a live room', T, async (t) => {
  const app = guarded(t, AT - 120000);
  assert.ok(app.domain.createDemoRoom().demo);
});

// ---- index.js: crashes are logged by the safe logger and exit 1 ----
const CRASH = path.join(ROOT, 'test-support', 'crash-preload.js');
const HANG = path.join(ROOT, 'test-support', 'hang-drain-preload.js');
const SIGPRE = path.join(ROOT, 'test-support', 'sigterm-preload.js');
const SIGCRASH = path.join(ROOT, 'test-support', 'signal-then-crash-preload.js');
// A short drain deadline (DRAIN_DEADLINE_MS), so a drain that never settles is cut off quickly.
const DEADLINE = 400;
const FAST = { DRAIN_DEADLINE_MS: String(DEADLINE) };

// index.js to its exit, in a data dir of its own.
async function runIndex(env, args) {
  const dir = mkTmp('idx-');
  try { return await spawnIndex(dir, env, args, 15000).exited; } finally { rmTmp(dir); }
}

for (const [kind, event] of [['reject', 'app.unhandled_rejection'], ['throw', 'app.uncaught_exception']]) {
  test(`index.js: an ${kind === 'reject' ? 'unhandled rejection' : 'uncaught exception'} is logged as ${event} with no message, and exits 1`, T, async () => {
    const r = await runIndex({ CRASH_KIND: kind, CRASH_TEXT: 'SECRET-crash-text-7' }, ['-r', CRASH]);
    assert.equal(r.code, 1, r.out);
    const lines = r.out.split('\n').filter((l) => l.includes(event));
    assert.equal(lines.length, 1, r.out);
    assert.match(lines[0], /^level=error /);
    assert.match(lines[0], /errorClass="Error"/);
    assert.ok(!r.out.includes('SECRET-crash-text-7'), 'the error message was written');
    assert.ok(/on :\d+ /.test(r.stdout.split('\n')[0]), 'the listen line is still the first line');
  });
}

// ---- Gate 2 batch ----
const { consumeSecrets } = require('../lib/config');
const net = require('node:net');

test('consumeSecrets reads the one list of secret names, removes them from the env it was given, and leaves the rest', () => {
  const env = { ROOM_PASSCODE: 'p', ANTHROPIC_API_KEY: 'k', DATABASE_URL: 'postgres://u:pw@h/d', PORT: '1' };
  const s = consumeSecrets(env);
  assert.deepEqual([s.passcode, s.apiKey, s.databaseUrl], ['p', 'k', 'postgres://u:pw@h/d']);
  assert.deepEqual(env, { PORT: '1' });
  assert.ok(!JSON.stringify(s).includes('pw'));
  assert.ok(!require('node:util').inspect(s).includes('pw'));
});

test('createApp refuses a database url with no store handed in, and has no shutdown(): bootApp owns the choice and drain() is the way out', T, async (t) => {
  const { config } = setup(t);
  assert.throws(() => createApp({ config, secrets: loadSecrets({ DATABASE_URL: 'postgres://u:pw@127.0.0.1:1/x' }), log: quietLog(), proxy: fakeProxy() }), (e) => /bootApp/.test(e.message) && !e.message.includes('pw'));
  const app = createApp({ config, secrets: loadSecrets({}), log: quietLog(), proxy: fakeProxy() });
  t.after(() => app.close());
  assert.equal(app.shutdown, undefined);
  assert.equal(typeof app.drain, 'function');
});

test('the write-failure guard comes after the passcode check, and its 503 carries the fixed code saving_unavailable in the HTTP body', T, async (t) => {
  const { config, file } = setup(t);
  const store = createStore({ file, log: quietLog() });
  store.load();
  store.health = () => ({ ok: false, failingSince: 1 });
  const app = createApp({ config, secrets: loadSecrets({ ROOM_PASSCODE: 'pw' }), log: quietLog(), proxy: fakeProxy(), store, clock: { now: () => 1700000000000, sleep: async () => {} } });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.server.closeAllConnections(); app.close(); });
  const post = (body) => fetch(`http://127.0.0.1:${app.server.address().port}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const wrong = await post({ modeA: 'external', modeB: 'external', passcode: 'nope' });
  assert.equal(wrong.status, 403, 'a wrong passcode is answered before the storage state is revealed');
  assert.deepEqual(await wrong.json(), { error: 'Wrong or missing passcode.' });
  const right = await post({ modeA: 'external', modeB: 'external', passcode: 'pw' });
  assert.equal(right.status, 503);
  assert.deepEqual(await right.json(), { error: 'Saving is unavailable right now. Try again in a minute.', code: 'saving_unavailable' });
});

test('index.js: a port that is taken is app.listen_failed, with the port and the code, and exits 1', T, async () => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  try {
    const port = holder.address().port;
    const dir = mkTmp('busy-');
    const { code, out } = await spawnIndex(dir, { PORT: String(port) }).exited;
    rmTmp(dir);
    assert.equal(code, 1, out);
    assert.match(out, /event="app\.listen_failed"[^\n]*code="EADDRINUSE"/);
    assert.ok(out.includes(`Behalf could not listen on port ${port} (EADDRINUSE)`), out);
  } finally { await new Promise((r) => holder.close(r)); }
});

// ---- index.js: the deadlines around a drain that never settles, and the one exit path ----
for (const [name, expected] of [['SIGTERM', 1], ['SIGINT', 130]]) {
  test(`index.js: a drain that never settles on ${name} is cut off after the drain deadline: app.drain_timeout, and exit ${expected}, never 0`, T, async (t) => {
    const trig = path.join(mkTmp('hang-trig-'), 'go');
    const dir = mkTmp('hang-');
    t.after(() => { rmTmp(dir); rmTmp(path.dirname(trig)); });
    const p = spawnIndex(dir, { ...FAST, SIGTERM_TRIGGER: trig, SIGNAL_NAME: name }, ['-r', HANG, '-r', SIGPRE], 15000);
    assert.ok(await p.listening, p.out());
    const t0 = Date.now();
    fs.writeFileSync(trig, '');
    const r = await p.exited;
    const took = Date.now() - t0;
    assert.deepEqual({ code: r.code, signal: r.signal }, { code: expected, signal: null }, r.out);
    assert.ok(took >= DEADLINE - 50 && took < DEADLINE + 3000, `left after about the ${DEADLINE} ms deadline, took ${took}`);
    assert.equal(r.out.split('\n').filter((l) => l.includes('app.drain_timeout')).length, 1, r.out);
    assert.match(r.out, /level=error event="app\.drain_timeout"/);
  });
}

for (const kind of ['reject', 'throw']) {
  test(`index.js: a crash (${kind}) while the drain hangs exits 1 within the bound, and logs app.drain_timeout`, T, async () => {
    const t0 = Date.now();
    const r = await runIndex({ ...FAST, CRASH_KIND: kind, CRASH_TEXT: 'x' }, ['-r', HANG, '-r', CRASH]);
    assert.equal(r.code, 1, r.out);
    assert.ok(Date.now() - t0 < DEADLINE + 3000, 'took ' + (Date.now() - t0));
    assert.equal(r.out.split('\n').filter((l) => l.includes('app.drain_timeout')).length, 1, r.out);
  });
}

test('index.js: the crash bound is 2 s even when the drain deadline is longer', T, async () => {
  const t0 = Date.now();
  const r = await runIndex({ DRAIN_DEADLINE_MS: '6000', CRASH_KIND: 'throw', CRASH_TEXT: 'x' }, ['-r', HANG, '-r', CRASH]);
  const took = Date.now() - t0;
  assert.equal(r.code, 1, r.out);
  assert.ok(took < 5000, 'left at the 2 s crash bound, not the 6 s deadline: ' + took);
});

test('index.js: the first reason to leave wins: a signal, then a crash while it drains, still ends as the signal says', T, async (t) => {
  const trig = path.join(mkTmp('latch-trig-'), 'go');
  const dir = mkTmp('latch-');
  t.after(() => { rmTmp(dir); rmTmp(path.dirname(trig)); });
  // SIGINT leaves with 130 after the 2.5 s deadline; the crash 100 ms later has a 2 s bound and would leave with 1 sooner
  const p = spawnIndex(dir, { DRAIN_DEADLINE_MS: '2500', SIGTERM_TRIGGER: trig }, ['-r', HANG, '-r', SIGCRASH], 15000);
  assert.ok(await p.listening, p.out());
  const t0 = Date.now();
  fs.writeFileSync(trig, '');
  const r = await p.exited;
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 130, signal: null }, r.out);
  assert.ok(Date.now() - t0 >= 2300, 'it waited for the first reason\'s deadline: ' + (Date.now() - t0));
  assert.equal(r.out.split('\n').filter((l) => l.includes('app.drain_timeout')).length, 1, r.out);
});

test('bootApp warns store.file_fallback once when the platform gave a data dir but no database, and not otherwise', T, async (t) => {
  guardEnv(t, ['DROP_DATA_DIR']);
  for (const [dropDir, want] of [['/somewhere', 1], [undefined, 0]]) {
    if (dropDir) process.env.DROP_DATA_DIR = dropDir; else delete process.env.DROP_DATA_DIR;
    const { config } = setup(t);
    const lines = [];
    const log = { info() {}, error() {}, warn: (e) => lines.push(e) };
    const app = await bootApp({ config, secrets: loadSecrets({}), log, proxy: fakeProxy() });
    await app.close();
    assert.equal(lines.filter((e) => e === 'store.file_fallback').length, want, String(dropDir));
  }
});

test('bootApp gives the injected clock to the file store too: its debounce timer comes from that clock', T, async (t) => {
  const { config } = setup(t);
  const timers = [];
  const clock = { sleep: async () => {}, setTimeout: (fn, ms) => { timers.push(ms); return { fn }; }, clearTimeout() {} };
  const app = await bootApp({ config, secrets: loadSecrets({}), log: quietLog(), proxy: fakeProxy(), clock });
  app.domain.createDemoRoom();
  assert.ok(timers.includes(300), 'the store armed its debounce on the injected clock: ' + JSON.stringify(timers));
  await app.close();
});

test('consumeSecrets deletes each of the five names on its own', () => {
  for (const name of ['ROOM_PASSCODE', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']) {
    const env = { [name]: 'v', KEEP: '1' };
    consumeSecrets(env);
    assert.deepEqual(env, { KEEP: '1' }, name);
  }
});
