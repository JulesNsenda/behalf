'use strict';
// lib/store against temp dirs and a capture logger. The failure cases inject a fs whose calls throw.
const test = require('node:test');
const assert = require('node:assert/strict');
const realFs = require('node:fs');
const path = require('node:path');
const { createStore, StoreError } = require('../lib/store');
const pxp = require('../lib/pxp');
const { ROOT } = require('../test-support/paths');
const { mkTmp, rmTmp } = require('../test-support/server');
const { sleep } = require('../test-support/http');
const { runStoreContract, minimalRoom, plain, capture } = require('../test-support/store-contract');
const core = require('../lib/store-core');

const FIXTURE = path.join(ROOT, 'test-support', 'fixtures', 'rooms.v0.json');
const QUARANTINE = /^rooms\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;
const PARTIAL = /^rooms\.json\.partial-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;

function setup(t, content, fs, opts) {
  const root = mkTmp('store-');
  t.after(() => rmTmp(root));
  const dir = path.join(root, 'data');
  const file = path.join(dir, 'rooms.json');
  if (content !== undefined) {
    realFs.mkdirSync(dir, { recursive: true });
    realFs.writeFileSync(file, content);
  }
  const log = capture();
  const store = createStore(Object.assign({ file, log, fs }, opts));
  t.after(() => store.close());
  return { dir, file, log, store, names: () => realFs.readdirSync(dir).sort(), disk: () => JSON.parse(realFs.readFileSync(file, 'utf8')) };
}

const fixture = () => JSON.parse(realFs.readFileSync(FIXTURE, 'utf8'));
const withFs = (over) => Object.assign({}, realFs, over);
// An injected fs that counts the opens of a store temp file, i.e. the writes.
function countOpens() {
  const c = { n: 0 };
  c.fs = withFs({ openSync(...a) { if (/\.tmp-/.test(String(a[0]))) c.n++; return realFs.openSync(...a); } });
  return c;
}
// A manual clock: timers fire only when the test advances time.
function manualClock() {
  const c = { t: 1000, timers: [] };
  c.now = () => c.t;
  c.setTimeout = (fn, ms) => { const h = { fn, at: c.t + ms }; c.timers.push(h); return h; };
  c.clearTimeout = (h) => { c.timers = c.timers.filter((x) => x !== h); };
  c.delays = () => c.timers.map((h) => h.at - c.t);
  c.advance = (ms) => { c.t += ms; for (const h of c.timers.filter((x) => x.at <= c.t)) { c.timers = c.timers.filter((x) => x !== h); h.fn(); } };
  return c;
}

const fsError = (code) => Object.assign(new Error('x'), { code });

test('the v0 fixture loads, verifies, saves as schemaVersion 1 and reloads equal', (t) => {
  const s = setup(t, JSON.stringify(fixture()));
  s.store.load();
  const n = Object.keys(fixture().rooms).length;
  assert.equal(s.store.state.rooms.size, n);
  for (const r of s.store.state.rooms.values()) {
    assert.equal(pxp.verifyLedger(r.ledger).ok, true, r.id);
    for (const seat of ['A', 'B']) assert.ok(r.seats[seat].mode, r.id + ' mode backfilled');
    assert.equal(typeof r.demo, 'boolean');
  }
  assert.equal(s.store.state.rooms.get('nomode01').seats.A.mode, 'builtin');
  const expected = JSON.parse(JSON.stringify(Object.fromEntries(s.store.state.rooms), (k, v) => (k === 'running' ? undefined : v)));
  s.store.flush();
  const onDisk = s.disk();
  assert.equal(onDisk.schemaVersion, 1);
  assert.deepEqual(Object.keys(onDisk).sort(), ['rooms', 'schemaVersion', 'usage']);
  const store2 = createStore({ file: s.file, log: capture() });
  store2.load();
  assert.deepEqual(Object.fromEntries(store2.state.rooms), expected);
  assert.deepEqual(plain(store2.state.usage), Object.assign({ failedByIp: {}, byUser: {} }, fixture().usage));
  for (const r of store2.state.rooms.values()) assert.equal(pxp.verifyLedger(r.ledger).ok, true, r.id);
  assert.deepEqual(s.log.lines, []);
});

test('v0 migration coerces demo to a boolean and backfills a missing seat mode', (t) => {
  const f = fixture();
  f.rooms.yes00001 = Object.assign(minimalRoom('yes00001'), { demo: 'yes' });
  delete f.rooms.yes00001.seats.A.mode;
  f.rooms.true0001 = Object.assign(minimalRoom('true0001'), { demo: true });
  const s = setup(t, JSON.stringify(f));
  s.store.load();
  assert.equal(s.store.state.rooms.get('yes00001').demo, false);
  assert.equal(s.store.state.rooms.get('yes00001').seats.A.mode, 'builtin');
  assert.equal(s.store.state.rooms.get('true0001').demo, true);
});

test('a v1 file is not migrated again', (t) => {
  const r = minimalRoom('v1room01');
  r.demo = 'kept';
  const s = setup(t, JSON.stringify({ schemaVersion: 1, rooms: { v1room01: r }, usage: { day: 'd', total: 2, byIp: { x: 2 } } }));
  s.store.load();
  assert.equal(s.store.state.rooms.get('v1room01').demo, 'kept');
  assert.deepEqual(plain(s.store.state.usage), { day: 'd', total: 2, byIp: { x: 2 }, failedByIp: {}, byUser: {} });
});

test('no file: empty state, and the data directory is created', (t) => {
  const s = setup(t);
  const st = s.store.load();
  assert.equal(st.rooms.size, 0);
  assert.deepEqual(plain(st.usage), { day: '', total: 0, byIp: {}, failedByIp: {}, byUser: {} });
  assert.ok(realFs.existsSync(s.dir));
  assert.deepEqual(s.log.lines, []);
});

test('a file that is not JSON is quarantined byte for byte, logged, and the store starts empty', (t) => {
  const bytes = '{"rooms": SECRET not json';
  const s = setup(t, bytes);
  s.store.load();
  assert.equal(s.store.state.rooms.size, 0);
  assert.equal(realFs.existsSync(s.file), false);
  const q = s.names().filter((n) => QUARANTINE.test(n));
  assert.equal(q.length, 1, s.names().join());
  assert.equal(realFs.readFileSync(path.join(s.dir, q[0]), 'utf8'), bytes);
  assert.deepEqual(s.log.events(), ['store.quarantined']);
  assert.ok(!JSON.stringify(s.log.lines).includes('SECRET'));
});

test('JSON of the wrong top-level shape is quarantined too', (t) => {
  for (const content of ['[]', 'null', '{"usage":{}}', '{"rooms":[]}', '{"schemaVersion":"1","rooms":{}}']) {
    const s = setup(t, content);
    s.store.load();
    assert.equal(s.store.state.rooms.size, 0, content);
    assert.equal(s.names().filter((n) => QUARANTINE.test(n)).length, 1, content);
  }
});

test('only the newest 5 quarantine files are kept', (t) => {
  const s = setup(t, 'not json');
  const d = s.dir;
  for (let i = 1; i <= 6; i++) realFs.writeFileSync(path.join(d, `rooms.json.corrupt-2020-01-0${i}T00-00-00.000Z`), 'old' + i);
  s.store.load();
  const q = s.names().filter((n) => n.startsWith('rooms.json.corrupt-'));
  assert.equal(q.length, 5);
  assert.ok(!q.includes('rooms.json.corrupt-2020-01-01T00-00-00.000Z'));
  assert.ok(!q.includes('rooms.json.corrupt-2020-01-02T00-00-00.000Z'));
  assert.ok(q.some((n) => QUARANTINE.test(n) && !n.includes('2020-01')), 'the new one is kept');
});

test('a failed quarantine rename throws EQUARANTINE and leaves the file alone', (t) => {
  const s = setup(t, 'not json', withFs({ renameSync() { throw fsError('EACCES'); } }));
  assert.throws(() => s.store.load(), (e) => e instanceof StoreError && e.code === 'EQUARANTINE');
  assert.equal(realFs.readFileSync(s.file, 'utf8'), 'not json');
});

test('a read error other than ENOENT throws StoreError with the fs code, and nothing is written', (t) => {
  const s = setup(t, '{"rooms":{}}', withFs({ readFileSync() { throw fsError('EACCES'); } }));
  assert.throws(() => s.store.load(), (e) => e instanceof StoreError && e.code === 'EACCES');
  assert.equal(realFs.readFileSync(s.file, 'utf8'), '{"rooms":{}}');
  assert.deepEqual(s.names(), ['rooms.json']);
});

test('a data directory that cannot be created throws StoreError', (t) => {
  const s = setup(t, undefined, withFs({ mkdirSync() { throw fsError('EROFS'); } }));
  assert.throws(() => s.store.load(), (e) => e instanceof StoreError && e.code === 'EROFS');
});

test('a schemaVersion newer than known throws EFUTURESCHEMA and leaves the file alone', (t) => {
  const content = JSON.stringify({ schemaVersion: 2, rooms: {}, usage: {} });
  const s = setup(t, content);
  assert.throws(() => s.store.load(), (e) => e instanceof StoreError && e.code === 'EFUTURESCHEMA');
  assert.equal(realFs.readFileSync(s.file, 'utf8'), content);
  assert.deepEqual(s.names(), ['rooms.json']);
});

test('a malformed room is skipped and logged; the others load', (t) => {
  const f = fixture();
  const good = Object.keys(f.rooms).length;
  f.rooms.bad00001 = 'nope';
  f.rooms.bad00002 = Object.assign(minimalRoom('bad00002'), { seats: { A: {} } });
  f.rooms.bad00003 = Object.assign(minimalRoom('bad00003'), { ledger: {} });
  f.rooms.bad00004 = Object.assign(minimalRoom('bad00004'), { envelopes: null });
  f.rooms.bad00005 = null;
  const s = setup(t, JSON.stringify(f));
  s.store.load();
  assert.equal(s.store.state.rooms.size, good);
  const skipped = s.log.lines.filter((l) => l.event === 'store.room_skipped').map((l) => l.fields.room).sort();
  assert.deepEqual(skipped, ['bad00001', 'bad00002', 'bad00003', 'bad00004', 'bad00005']);
});

test('a room that cannot be serialised is skipped on save; the others are written', (t) => {
  const s = setup(t);
  s.store.load();
  const deep = [];
  let cur = deep;
  for (let i = 0; i < 200000; i++) { const n = []; cur.push(n); cur = n; }
  s.store.state.rooms.set('okroom01', minimalRoom('okroom01'));
  s.store.state.rooms.set('bigint01', Object.assign(minimalRoom('bigint01'), { x: 1n }));
  s.store.state.rooms.set('deep0001', Object.assign(minimalRoom('deep0001'), { x: deep }));
  s.store.state.rooms.set('okroom02', minimalRoom('okroom02'));
  s.store.flush();
  const disk = s.disk();
  assert.deepEqual(Object.keys(disk.rooms), ['okroom01', 'okroom02']);
  const bad = s.log.lines.filter((l) => l.event === 'store.room_unserialisable').map((l) => l.fields.room);
  assert.deepEqual(bad, ['bigint01', 'deep0001']);
  assert.ok(!s.log.events().includes('store.save_failed'));
});

test('save drops the running flag and serialises the current usage object', (t) => {
  const s = setup(t);
  s.store.load();
  s.store.state.rooms.set('run00001', Object.assign(minimalRoom('run00001'), { running: true }));
  s.store.state.usage = { day: '2026-01-01', total: 3, byIp: { a: 3 } };
  s.store.flush();
  const disk = s.disk();
  assert.equal('running' in disk.rooms.run00001, false);
  assert.deepEqual(disk.usage, { day: '2026-01-01', total: 3, byIp: { a: 3 } });
});

test('no .tmp is left after a save, or after a failed one', (t) => {
  const s = setup(t);
  s.store.load();
  s.store.state.rooms.set('okroom01', minimalRoom('okroom01'));
  s.store.flush();
  assert.deepEqual(s.names(), ['rooms.json']);
  const f = setup(t, undefined, withFs({ renameSync() { throw fsError('EACCES'); } }));
  f.store.load();
  f.store.flush();
  assert.deepEqual(f.names(), []);
  assert.deepEqual(f.log.events(), ['store.save_failed']);
});

test('save() calls inside the debounce window coalesce into one write', async (t) => {
  const w = countOpens();
  const s = setup(t, undefined, w.fs, { debounceMs: 20 });
  s.store.load();
  s.store.save(); s.store.save(); s.store.save();
  assert.equal(w.n, 0, 'nothing is written synchronously');
  await sleep(60);
  assert.equal(w.n, 1);
  assert.ok(realFs.existsSync(s.file));
});

test('flush() writes before it returns and cancels the pending debounce', async (t) => {
  const w = countOpens();
  const s = setup(t, undefined, w.fs, { debounceMs: 20 });
  s.store.load();
  s.store.state.rooms.set('okroom01', minimalRoom('okroom01'));
  s.store.save();
  s.store.flush();
  assert.equal(w.n, 1);
  assert.ok(s.disk().rooms.okroom01);
  await sleep(60);
  assert.equal(w.n, 1, 'the debounced write was cancelled');
});

test('rename is retried on EPERM and succeeds the second time', (t) => {
  let calls = 0;
  const s = setup(t, undefined, withFs({ renameSync(...a) { if (++calls === 1) throw fsError('EPERM'); return realFs.renameSync(...a); } }), { platform: 'win32' });
  s.store.load();
  s.store.flush();
  assert.equal(calls, 2);
  assert.deepEqual(s.log.lines, []);
  assert.deepEqual(s.names(), ['rooms.json']);
});

test('rename gives up after 5 tries on a persistent EBUSY, logs, and keeps the old file', (t) => {
  let calls = 0;
  const old = JSON.stringify({ schemaVersion: 1, rooms: {}, usage: { day: 'old', total: 0, byIp: {} } });
  const s = setup(t, old, withFs({ renameSync() { calls++; throw fsError('EBUSY'); } }), { platform: 'win32' });
  s.store.load();
  s.store.flush();
  assert.equal(calls, 5);
  assert.deepEqual(s.log.events(), ['store.save_failed']);
  assert.equal(s.disk().usage.day, 'old');
});

test('file mode 0600 and directory mode 0700', { skip: process.platform === 'win32' }, (t) => {
  const s = setup(t);
  s.store.load();
  s.store.flush();
  assert.equal(realFs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal(realFs.statSync(s.dir).mode & 0o777, 0o700);
});

test('a skipped room keeps the original bytes in a .partial- file, which pruning leaves alone; the room is gone from the next save', (t) => {
  const f = fixture();
  f.rooms.bad00001 = 'nope';
  const bytes = JSON.stringify(f);
  const s = setup(t, bytes);
  const d = s.dir;
  s.store.load();
  const partial = s.names().filter((n) => PARTIAL.test(n));
  assert.equal(partial.length, 1, s.names().join());
  assert.equal(realFs.readFileSync(path.join(d, partial[0]), 'utf8'), bytes);
  s.store.flush();
  const disk = s.disk();
  assert.equal('bad00001' in disk.rooms, false);
  assert.equal(Object.keys(disk.rooms).length, Object.keys(fixture().rooms).length);
  // A later quarantine prunes corrupt files only.
  const s2 = setup(t, 'not json');
  const d2 = s2.dir;
  realFs.writeFileSync(path.join(d2, 'rooms.json.partial-2020-01-01T00-00-00.000Z'), 'keep');
  for (let i = 1; i <= 6; i++) realFs.writeFileSync(path.join(d2, `rooms.json.corrupt-2020-01-0${i}T00-00-00.000Z`), 'old');
  s2.store.load();
  assert.ok(s2.names().includes('rooms.json.partial-2020-01-01T00-00-00.000Z'));
});

test('a failed .partial copy throws EPRESERVE; every room skipped throws EALLSKIPPED and writes nothing', (t) => {
  const f = fixture();
  f.rooms.bad00001 = 'nope';
  const s = setup(t, JSON.stringify(f), withFs({ copyFileSync() { throw fsError('EACCES'); } }));
  assert.throws(() => s.store.load(), (e) => e instanceof StoreError && e.code === 'EPRESERVE');
  const all = JSON.stringify({ schemaVersion: 1, rooms: { a0000001: 'x', b0000001: {} }, usage: {} });
  const s2 = setup(t, all);
  assert.throws(() => s2.store.load(), (e) => e instanceof StoreError && e.code === 'EALLSKIPPED');
  assert.equal(realFs.readFileSync(s2.file, 'utf8'), all);
  assert.deepEqual(s2.names(), ['rooms.json']);
});

test('a room whose id does not match its key, or that has no token or claims, is skipped', (t) => {
  const f = fixture();
  const good = Object.keys(f.rooms).length;
  f.rooms.key00001 = minimalRoom('other001');
  f.rooms.notoken1 = minimalRoom('notoken1');
  delete f.rooms.notoken1.seats.A.token;
  f.rooms.noclaims = minimalRoom('noclaims');
  delete f.rooms.noclaims.claims;
  const s = setup(t, JSON.stringify(f));
  s.store.load();
  assert.equal(s.store.state.rooms.size, good);
  assert.equal(s.log.lines.filter((l) => l.event === 'store.room_skipped').length, 3);
});

test('a room whose migration throws is skipped', (t) => {
  const f = fixture();
  const good = Object.keys(f.rooms).length;
  f.rooms.badseats = minimalRoom('badseats');
  f.rooms.badseats.seats.A = null;
  const s = setup(t, JSON.stringify(f));
  s.store.load();
  assert.equal(s.store.state.rooms.size, good);
  assert.deepEqual(s.log.lines.filter((l) => l.event === 'store.room_skipped').map((l) => l.fields.room), ['badseats']);
});

test('a short write is looped to completion', (t) => {
  let shorts = 0;
  const s = setup(t, undefined, withFs({ writeSync(fd, buf, off, len) { shorts++; return realFs.writeSync(fd, buf, off, Math.min(len, 3)); } }));
  s.store.load();
  s.store.state.rooms.set('okroom01', minimalRoom('okroom01'));
  s.store.flush();
  assert.ok(shorts > 3);
  assert.deepEqual(s.log.lines, []);
  assert.ok(s.disk().rooms.okroom01);
});

test('a write that stops making progress fails the save and leaves rooms.json intact', (t) => {
  const old = JSON.stringify({ schemaVersion: 1, rooms: {}, usage: { day: 'old', total: 0, byIp: {} } });
  const s = setup(t, old, withFs({ writeSync() { return 0; } }));
  s.store.load();
  s.store.flush();
  assert.deepEqual(s.log.events(), ['store.save_failed']);
  assert.equal(realFs.readFileSync(s.file, 'utf8'), old);
  assert.deepEqual(s.names(), ['rooms.json']);
});

test('steady save() calls do not starve the write', async (t) => {
  const w = countOpens();
  const s = setup(t, undefined, w.fs, { debounceMs: 20 });
  s.store.load();
  for (let i = 0; i < 20; i++) { s.store.save(); await sleep(10); }
  assert.ok(w.n >= 1, 'writes during the burst: ' + w.n);
  s.store.close();
});

test('save(id) serialises only that room again', (t) => {
  const s = setup(t);
  s.store.load();
  const counts = { x: 0, y: 0 };
  for (const k of ['x', 'y']) {
    const r = minimalRoom(k);
    Object.defineProperty(r, 'probe', { enumerable: true, get() { counts[k]++; return 1; } });
    s.store.state.rooms.set(k, r);
  }
  s.store.flush();
  assert.deepEqual(counts, { x: 1, y: 1 });
  s.store.state.rooms.get('x').note = 'changed';
  s.store.save('x');
  s.store.flush();
  assert.deepEqual(counts, { x: 2, y: 1 });
  assert.equal(s.disk().rooms.x.note, 'changed');
  s.store.state.rooms.delete('y');
  s.store.save('y'); // as eviction does: a pass with nothing marked writes nothing
  s.store.flush();
  assert.deepEqual(Object.keys(s.disk().rooms), ['x']);
});

test('a room that stops serialising keeps its last good copy on disk, and is logged once', (t) => {
  const s = setup(t);
  s.store.load();
  const r = minimalRoom('okroom01');
  r.note = 'good';
  s.store.state.rooms.set('okroom01', r);
  s.store.flush();
  r.note = 1n;
  s.store.save();
  s.store.flush();
  s.store.save();
  s.store.flush();
  assert.equal(s.disk().rooms.okroom01.note, 'good');
  assert.equal(s.log.lines.filter((l) => l.event === 'store.room_unserialisable').length, 1);
  r.note = 'fixed';
  s.store.save();
  s.store.flush();
  assert.equal(s.disk().rooms.okroom01.note, 'fixed');
});

test('a running key nested inside a room survives a round-trip; the top-level one does not', (t) => {
  const s = setup(t);
  s.store.load();
  const r = minimalRoom('okroom01');
  r.running = true;
  r.seats.A.card = { running: 'a user field', nested: { running: 1 } };
  s.store.state.rooms.set('okroom01', r);
  s.store.flush();
  const back = s.disk().rooms.okroom01;
  assert.equal('running' in back, false);
  assert.deepEqual(back.seats.A.card, { running: 'a user field', nested: { running: 1 } });
});

test('a BOM-prefixed file loads', (t) => {
  const bom = String.fromCharCode(0xFEFF);
  const s = setup(t, bom + JSON.stringify({ schemaVersion: 1, rooms: { okroom01: minimalRoom('okroom01') }, usage: {} }));
  s.store.load();
  assert.equal(s.store.state.rooms.size, 1);
  assert.deepEqual(s.names(), ['rooms.json']);
});

test('stored byIp keys such as __proto__ cannot touch prototypes; bad numbers are dropped; usage identity is stable', (t) => {
  const s = setup(t, '{"schemaVersion":1,"rooms":{},"usage":{"day":"d","total":4,"byIp":{"__proto__":2,"constructor":3,"1.2.3.4":2,"bad":-1,"worse":"x"}}}');
  const usage = s.store.state.usage;
  const rooms = s.store.state.rooms;
  s.store.load();
  assert.equal(s.store.state.usage, usage);
  assert.equal(s.store.state.rooms, rooms);
  assert.equal(Object.getPrototypeOf(usage.byIp), null);
  assert.deepEqual(Object.keys(usage.byIp).sort(), ['1.2.3.4', '__proto__', 'constructor']);
  assert.equal(({}).polluted, undefined);
  s.store.resetUsage('e');
  assert.equal(s.store.state.usage, usage);
  assert.deepEqual([usage.day, usage.total, Object.keys(usage.byIp).length, Object.getPrototypeOf(usage.byIp)], ['e', 0, 0, null]);
});

test('stored failedByIp gets the same null-prototype and finite-number handling, and resetUsage clears it', (t) => {
  const s = setup(t, '{"schemaVersion":1,"rooms":{},"usage":{"day":"d","total":1,"byIp":{},"failedByIp":{"__proto__":2,"1.2.3.4":3,"bad":-1,"worse":"x"}}}');
  s.store.load();
  const f = s.store.state.usage.failedByIp;
  assert.equal(Object.getPrototypeOf(f), null);
  assert.deepEqual(Object.keys(f).sort(), ['1.2.3.4', '__proto__']);
  assert.equal(({}).polluted, undefined);
  s.store.resetUsage('e');
  assert.equal(Object.getPrototypeOf(s.store.state.usage.failedByIp), null);
  assert.deepEqual(Object.keys(s.store.state.usage.failedByIp), []);
});

test('stale tmp files are removed at load; load twice throws', (t) => {
  const s = setup(t, JSON.stringify({ schemaVersion: 1, rooms: {}, usage: {} }));
  realFs.writeFileSync(s.file + '.tmp', 'x');
  realFs.writeFileSync(s.file + '.tmp-1234-abcd', 'x');
  s.store.load();
  assert.deepEqual(s.names(), ['rooms.json']);
  assert.throws(() => s.store.load(), (e) => e instanceof StoreError && e.code === 'ELOADED');
});

test('close() cancels a pending write and later saves do nothing', async (t) => {
  const s = setup(t, undefined, undefined, { debounceMs: 20 });
  s.store.load();
  s.store.save();
  s.store.close();
  s.store.save();
  await sleep(60);
  assert.equal(realFs.existsSync(s.file), false);
});

test('a too-large file throws ETOOLARGE', (t) => {
  const s = setup(t, '{}', withFs({ readFileSync() { throw Object.assign(new Error('x'), { code: 'ERR_STRING_TOO_LONG' }); } }));
  assert.throws(() => s.store.load(), (e) => e instanceof StoreError && e.code === 'ETOOLARGE');
});

test('quarantine logs EPARSE or ESHAPE as the code', (t) => {
  const { errorFields } = require('../lib/log');
  const a = setup(t, 'not json');
  a.store.load();
  assert.equal(errorFields(a.log.lines[0].err).code, 'EPARSE');
  const b = setup(t, '[]');
  b.store.load();
  assert.equal(errorFields(b.log.lines[0].err).code, 'ESHAPE');
});

test('an existing loose dir and file are tightened on load; the quarantine copy is 0600', { skip: process.platform === 'win32' }, (t) => {
  const s = setup(t, JSON.stringify({ schemaVersion: 1, rooms: {}, usage: {} }));
  realFs.chmodSync(s.dir, 0o755);
  realFs.chmodSync(s.file, 0o644);
  s.store.load();
  assert.equal(realFs.statSync(s.dir).mode & 0o777, 0o700);
  assert.equal(realFs.statSync(s.file).mode & 0o777, 0o600);
  const q = setup(t, 'not json');
  realFs.chmodSync(q.file, 0o644);
  q.store.load();
  const name = q.names().find((n) => QUARANTINE.test(n));
  assert.equal(realFs.statSync(path.join(q.dir, name)).mode & 0o777, 0o600);
});

test('rooms changed in memory right after load (restart rules) are written by the first save(id) of another room', (t) => {
  const a = minimalRoom('aaaa0001'); a.status = 'negotiating';
  const b = minimalRoom('bbbb0002'); b.status = 'negotiating';
  const s = setup(t, JSON.stringify({ schemaVersion: 1, rooms: { aaaa0001: a, bbbb0002: b } }));
  s.store.load();
  // What index.js does after load: mutate every room without calling save().
  for (const r of s.store.state.rooms.values()) { r.status = 'paused'; r.interrupted = true; }
  s.store.state.rooms.set('cccc0003', minimalRoom('cccc0003'));
  s.store.save('cccc0003'); // only the new room is named
  s.store.flush();
  const rooms = s.disk().rooms;
  assert.equal(rooms.aaaa0001.status, 'paused');
  assert.equal(rooms.aaaa0001.interrupted, true);
  assert.equal(rooms.bbbb0002.status, 'paused');
});

test('an old persisted failedTotal is ignored', (t) => {
  const s = setup(t, '{"schemaVersion":1,"rooms":{},"usage":{"day":"d","total":1,"byIp":{},"failedTotal":7}}');
  s.store.load();
  assert.equal('failedTotal' in s.store.state.usage, false);
  s.store.flush();
  assert.equal('failedTotal' in s.disk().usage, false);
});

test('saveUsage schedules a write without marking rooms dirty', (t) => {
  const s = setup(t, JSON.stringify({ schemaVersion: 1, rooms: {}, usage: {} }));
  s.store.load();
  s.store.state.usage.failedByIp.x = 3;
  s.store.saveUsage();
  s.store.flush();
  assert.deepEqual(s.disk().usage.failedByIp, { x: 3 });
});

test('.partial- copies are never pruned: six old ones and the new one all survive, and so do the corrupt files', (t) => {
  const f = fixture();
  f.rooms.bad00001 = 'nope';
  const s = setup(t, JSON.stringify(f));
  for (let i = 1; i <= 6; i++) realFs.writeFileSync(path.join(s.dir, `rooms.json.partial-2020-01-0${i}T00-00-00.000Z`), 'old' + i);
  for (let i = 1; i <= 6; i++) realFs.writeFileSync(path.join(s.dir, `rooms.json.corrupt-2020-01-0${i}T00-00-00.000Z`), 'old' + i);
  s.store.load();
  const p = s.names().filter((n) => n.startsWith('rooms.json.partial-'));
  assert.equal(p.length, 7);
  for (let i = 1; i <= 6; i++) assert.ok(p.includes(`rooms.json.partial-2020-01-0${i}T00-00-00.000Z`), 'old copy ' + i);
  assert.equal(s.names().filter((n) => n.startsWith('rooms.json.corrupt-')).length, 6);
});

// The contract every backend passes, against the file store in a temp dir.
runStoreContract('file store', async () => {
  const root = mkTmp('store-contract-');
  const dir = path.join(root, 'data');
  const file = path.join(dir, 'rooms.json');
  const opened = [];
  const open = () => { const store = createStore({ file, log: capture(), debounceMs: 20 }); store.load(); opened.push(store); return store; };
  open();
  return {
    store: opened[0],
    reopen: async () => { const last = opened[opened.length - 1]; await last.settle(); await last.close(); return open(); },
    seed: async ({ rooms = {}, usage = {}, users, sessions, agentkeys } = {}, version = 1) => {
      for (const s of opened) await s.close(); // closed without a write: the seed must not be overwritten
      realFs.mkdirSync(dir, { recursive: true });
      realFs.writeFileSync(file, JSON.stringify({ schemaVersion: version, rooms, usage, users, sessions, agentkeys }));
    },
    // A skipped room is kept in the .partial copy the load makes.
    preserved: async (id) => realFs.readdirSync(dir).filter((n) => PARTIAL.test(n)).some((n) => id in JSON.parse(realFs.readFileSync(path.join(dir, n), 'utf8')).rooms),
    cleanup: async () => { for (const s of opened) await s.close(); rmTmp(root); },
  };
});

test('a v1 file without users, sessions, agentkeys or byUser loads, with every collection empty', (t) => {
  const s = setup(t, JSON.stringify({ schemaVersion: 1, rooms: { v1room01: minimalRoom('v1room01') }, usage: { day: 'd', total: 1, byIp: { x: 1 } } }));
  s.store.load();
  for (const k of core.KINDS) assert.equal(s.store.collection(k).map.size, 0);
  assert.deepEqual(plain(s.store.state.usage.byUser), {});
  assert.equal(Object.getPrototypeOf(s.store.state.usage.byUser), null);
  assert.deepEqual(s.log.lines, []);
});

test('a store with no accounts writes exactly the bytes a build from before accounts wrote', (t) => {
  const s = setup(t);
  s.store.load();
  const room = minimalRoom('okroom01');
  s.store.state.rooms.set('okroom01', room);
  Object.assign(s.store.state.usage, { day: '2026-10-03', total: 2 });
  s.store.state.usage.byIp['1.2.3.4'] = 2;
  s.store.flush();
  // HEAD wrote { schemaVersion, rooms, usage: { day, total, byIp, failedByIp } } and nothing else.
  const expected = '{"schemaVersion":1,"rooms":{"okroom01":' + JSON.stringify(room) + '},"usage":{"day":"2026-10-03","total":2,"byIp":{"1.2.3.4":2},"failedByIp":{}}}';
  assert.equal(realFs.readFileSync(s.file, 'utf8'), expected);
  s.store.state.usage.byUser.u1 = 1;
  s.store.saveUsage();
  s.store.flush();
  assert.deepEqual(s.disk().usage.byUser, { u1: 1 }, 'written once it has entries');
});

test('collections are written only when non-empty; an older reader (plain JSON.parse) still sees schemaVersion 1 and the rooms', (t) => {
  const s = setup(t);
  s.store.load();
  s.store.state.rooms.set('okroom01', minimalRoom('okroom01'));
  s.store.flush();
  assert.deepEqual(Object.keys(s.disk()).sort(), ['rooms', 'schemaVersion', 'usage']);
  const c = s.store.collection('user');
  c.map.set('42', { id: '42', login: 'octo' });
  c.save('42');
  s.store.flush();
  const disk = s.disk();
  assert.equal(disk.schemaVersion, 1);
  assert.deepEqual(Object.keys(disk).sort(), ['rooms', 'schemaVersion', 'usage', 'users']);
  assert.deepEqual(disk.users, { 42: { id: '42', login: 'octo' } });
  assert.ok(disk.rooms.okroom01);
});

test('stored byUser goes through counts(): null prototype, __proto__ is a plain key, negative and non-number values dropped', (t) => {
  const s = setup(t, '{"schemaVersion":1,"rooms":{},"usage":{"day":"d","total":1,"byIp":{},"byUser":{"__proto__":2,"neg":-1,"str":"x","ok":3}}}');
  s.store.load();
  const b = s.store.state.usage.byUser;
  assert.equal(Object.getPrototypeOf(b), null);
  assert.deepEqual(Object.keys(b).sort(), ['__proto__', 'ok']);
  assert.equal(({}).polluted, undefined);
});

test('a bad collection record is logged at error level without its id, and the load keeps a .partial copy of the file first', (t) => {
  const bytes = JSON.stringify({ schemaVersion: 1, rooms: { okroom01: minimalRoom('okroom01') }, usage: {}, users: { secretid1: 'x', ok1: { a: 1 }, arr: [] } });
  const s = setup(t, bytes);
  s.store.load();
  assert.deepEqual([...s.store.collection('user').map.keys()], ['ok1']);
  assert.deepEqual(s.log.lines.map((l) => [l.level, l.event, l.fields]), [['error', 'store.record_skipped', {}], ['error', 'store.record_skipped', {}]]);
  assert.ok(!JSON.stringify(s.log.lines).includes('secretid1'));
  const partial = s.names().filter((n) => PARTIAL.test(n));
  assert.equal(partial.length, 1);
  assert.equal(realFs.readFileSync(path.join(s.dir, partial[0]), 'utf8'), bytes);
});

test('a collection that is present but not an object is logged and also keeps a .partial copy; a missing one does not', (t) => {
  const s = setup(t, JSON.stringify({ schemaVersion: 1, rooms: { okroom01: minimalRoom('okroom01') }, usage: {}, sessions: [], agentkeys: 'no' }));
  s.store.load();
  assert.equal(s.store.collection('session').map.size, 0);
  assert.deepEqual(s.log.lines.map((l) => [l.level, l.event]), [['error', 'store.record_skipped'], ['error', 'store.record_skipped']]);
  assert.equal(s.names().filter((n) => PARTIAL.test(n)).length, 1);
  const clean = setup(t, JSON.stringify({ schemaVersion: 1, rooms: { okroom01: minimalRoom('okroom01') }, usage: {} }));
  clean.store.load();
  assert.equal(clean.names().filter((n) => PARTIAL.test(n)).length, 0);
});

test('a failed .partial copy for a bad collection record throws EPRESERVE, and nothing is written', (t) => {
  const s = setup(t, JSON.stringify({ schemaVersion: 1, rooms: { okroom01: minimalRoom('okroom01') }, usage: {}, users: { a: 'x' } }), withFs({ copyFileSync() { throw fsError('EACCES'); } }));
  assert.throws(() => s.store.load(), (e) => e instanceof StoreError && e.code === 'EPRESERVE');
  assert.equal(s.store.flush(), false, 'not loaded: no write');
  assert.deepEqual(s.names(), ['rooms.json']);
});

test('a stored doc with an own __proto__, constructor or prototype key is skipped, not loaded', (t) => {
  const room = JSON.stringify(minimalRoom('okroom01'));
  const s = setup(t, '{"schemaVersion":1,"rooms":{"okroom01":' + room + '},"usage":{},"sessions":{"p":{"__proto__":{"admin":true}},"c":{"constructor":1},"q":{"prototype":1},"ok":{"userId":"1"}}}');
  s.store.load();
  assert.deepEqual([...s.store.collection('session').map.keys()], ['ok']);
  assert.equal(s.log.lines.filter((l) => l.event === 'store.record_skipped').length, 3);
  assert.equal(({}).admin, undefined);
});

test('a collection record that throws keeps its last good copy and is logged once, with no id', (t) => {
  const s = setup(t);
  s.store.load();
  const c = s.store.collection('session');
  const doc = { userId: '1', note: 'good' };
  c.map.set('sess-secret', doc);
  s.store.flush();
  doc.note = 1n;
  c.save('sess-secret');
  s.store.flush();
  c.save('sess-secret');
  s.store.flush();
  assert.equal(s.disk().sessions['sess-secret'].note, 'good');
  const lines = s.log.lines.filter((l) => l.event === 'store.record_unserialisable');
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].fields, {});
});

test('a non-string collection key is skipped and logged as store.record_bad_id without the id, and the file stays valid JSON', (t) => {
  const s = setup(t);
  s.store.load();
  const c = s.store.collection('user');
  c.map.set(42, { id: 42 });
  c.map.set('ok', { id: 'ok' });
  assert.equal(s.store.flush(), true);
  assert.deepEqual(Object.keys(s.disk().users), ['ok']);
  assert.deepEqual(s.log.lines.map((l) => [l.level, l.event, l.fields]), [['error', 'store.record_bad_id', {}]]);
});

test('resetUsage schedules a write by itself', (t) => {
  const clock = manualClock();
  const s = setup(t, undefined, undefined, { debounceMs: 20, clock });
  s.store.load();
  s.store.state.usage.byUser.u1 = 2;
  s.store.resetUsage('2026-10-04');
  assert.deepEqual(clock.delays(), [20]);
  clock.advance(20);
  assert.deepEqual(s.disk().usage, { day: '2026-10-04', total: 0, byIp: {}, failedByIp: {} });
});

test('before load(), resetUsage, settle, drain and persist write nothing and leave an existing rooms.json byte-identical', async (t) => {
  const bytes = JSON.stringify({ schemaVersion: 1, rooms: { okroom01: minimalRoom('okroom01') }, usage: { day: 'keep', total: 9, byIp: {} } });
  const s = setup(t, bytes, undefined, { debounceMs: 10 });
  s.store.resetUsage('x');
  s.store.save('okroom01');
  assert.equal(s.store.flush(), false);
  assert.equal(await s.store.settle(), false);
  assert.equal(await s.store.persist('room', 'okroom01'), false);
  await sleep(40);
  assert.equal(await s.store.drain(), false);
  assert.equal(realFs.readFileSync(s.file, 'utf8'), bytes);
  assert.deepEqual(s.names(), ['rooms.json']);
});

test('a failed write marks its records dirty again, retries by itself, and health() reports the streak', (t) => {
  let fail = true;
  const clock = manualClock();
  const s = setup(t, undefined, withFs({ renameSync(...a) { if (fail) throw fsError('EACCES'); return realFs.renameSync(...a); } }), { debounceMs: 20, clock });
  s.store.load();
  assert.deepEqual(s.store.health(), { ok: true, failingSince: null });
  s.store.state.rooms.set('okroom01', minimalRoom('okroom01'));
  s.store.save('okroom01');
  assert.equal(s.store.flush(), false);
  const first = s.store.health();
  assert.equal(first.ok, false);
  assert.equal(typeof first.failingSince, 'number');
  assert.equal(s.store.flush(), false);
  assert.equal(s.store.health().failingSince, first.failingSince, 'the streak keeps its first failure time');
  fail = false;
  assert.deepEqual(clock.delays(), [200], 'the retry the failed write scheduled, after the backoff: a base of at least 100 ms, doubled once');
  clock.advance(200);
  assert.ok(s.disk().rooms.okroom01, 'the room was written without another save()');
  assert.deepEqual(s.store.health(), { ok: true, failingSince: null });
});

test('persist() resolves false after a failed write and on a closed store; an unknown kind throws, with or without an id', async (t) => {
  let fail = true;
  const s = setup(t, undefined, withFs({ renameSync(...a) { if (fail) throw fsError('EACCES'); return realFs.renameSync(...a); } }));
  s.store.load();
  assert.equal(await s.store.persist('room'), false);
  fail = false;
  assert.equal(await s.store.persist('room'), true);
  assert.throws(() => s.store.persist('nope', 'x'), /unknown collection kind/);
  assert.throws(() => s.store.persist('nope'), /unknown collection kind/);
  await s.store.close();
  assert.equal(await s.store.persist('room'), false);
  assert.equal(s.store.flush(), false);
});

test('collection(kind).save() after close() schedules no write', async (t) => {
  const w = countOpens();
  const clock = manualClock();
  const s = setup(t, undefined, w.fs, { debounceMs: 20, clock });
  s.store.load();
  const c = s.store.collection('user');
  await s.store.close();
  c.map.set('u1', { a: 1 });
  c.save('u1');
  c.save();
  s.store.save('x');
  assert.deepEqual(clock.delays(), [], 'no timer was armed');
  clock.advance(80);
  assert.equal(w.n, 0);
  assert.equal(realFs.existsSync(s.file), false);
});

test('a no-id save of one kind serialises only that kind again', (t) => {
  const s = setup(t);
  s.store.load();
  const probes = { room: 0, user: 0 };
  const r = minimalRoom('okroom01');
  Object.defineProperty(r, 'probe', { enumerable: true, get() { probes.room++; return 1; } });
  s.store.state.rooms.set('okroom01', r);
  const doc = {};
  Object.defineProperty(doc, 'probe', { enumerable: true, get() { probes.user++; return 1; } });
  s.store.collection('user').map.set('u1', doc);
  s.store.flush();
  assert.deepEqual(probes, { room: 1, user: 1 });
  s.store.collection('user').save();
  s.store.flush();
  assert.deepEqual(probes, { room: 1, user: 2 });
  s.store.save();
  s.store.flush();
  assert.deepEqual(probes, { room: 2, user: 2 });
});

test('skipped ids are exposed through isSkipped(kind, id), per kind, and only through it', (t) => {
  const f = fixture();
  f.rooms.bad00001 = 'nope';
  f.users = { secretid1: 'x', ok1: { a: 1 } };
  const s = setup(t, JSON.stringify(f));
  s.store.load();
  assert.equal(s.store.isSkipped('room', 'bad00001'), true);
  assert.equal(s.store.isSkipped('room', 'nomode01'), false);
  assert.equal(s.store.isSkipped('user', 'secretid1'), true);
  assert.equal(s.store.isSkipped('user', 'ok1'), false);
  assert.equal(s.store.isSkipped('session', 'bad00001'), false, 'kinds do not mix');
  assert.equal(s.store.isSkipped('usage', 'today'), false);
  assert.equal('skipped' in s.store, false);
});

test("collection('room') is the rooms map and save(id) is its alias; collection('usage') is not for callers", (t) => {
  const s = setup(t);
  s.store.load();
  const c = s.store.collection('room');
  assert.equal(c.map, s.store.state.rooms);
  c.map.set('okroom01', minimalRoom('okroom01'));
  c.save('okroom01');
  s.store.flush();
  assert.ok(s.disk().rooms.okroom01);
  assert.throws(() => s.store.collection('usage'), /unknown collection kind/);
});

test('parseStoreDoc does no I/O and migrates rooms in place: it validates, and reports the unusable cases as an error', () => {
  const doc = core.parseStoreDoc({ rooms: { a0000001: minimalRoom('a0000001'), b0000001: 'x' }, usage: { day: 'd', total: 1 }, users: { u: { a: 1 }, v: 3 } });
  assert.equal(doc.version, 0);
  assert.deepEqual(doc.records.room.map(([id]) => id), ['a0000001']);
  assert.deepEqual(doc.skipped, { room: ['b0000001'], user: ['v'], session: [], agentkey: [] });
  assert.equal(doc.partial, true);
  assert.deepEqual([doc.records.user, doc.records.session, doc.records.agentkey], [[['u', { a: 1 }]], [], []]);
  assert.equal(doc.records.usage[0][1].total, 1);
  assert.deepEqual(core.parseStoreDoc([]), { error: 'ESHAPE' });
  assert.deepEqual(core.parseStoreDoc({ rooms: [] }), { error: 'ESHAPE' });
  assert.deepEqual(core.parseStoreDoc({ schemaVersion: 2, rooms: {} }), { error: 'EFUTURESCHEMA' });
  assert.deepEqual(core.parseStoreDoc({ rooms: { a: 'x' } }), { error: 'EALLSKIPPED' });
});

test('the serialiser: pass() changes nothing until commit(); removed covers dirty and cached ids, strings only', () => {
  const log = capture();
  const ser = core.createSerialiser(log);
  const map = new Map([['a', { n: 1 }], ['b', { n: 2 }]]);
  const r1 = ser.pass('session', map, { all: true });
  assert.deepEqual(r1.upserts, [['a', '{"n":1}'], ['b', '{"n":2}']]);
  const again = ser.pass('session', map, { all: false, dirty: new Set() });
  assert.equal(again.upserts.length, 2, 'not committed: still uncached');
  ser.commit('session', r1);
  assert.deepEqual(ser.pass('session', map, { dirty: new Set() }), { upserts: [], removed: [], failed: [] });
  map.delete('a');
  assert.deepEqual(ser.pass('session', map, { dirty: new Set() }).removed, ['a'], 'a cached id no longer in the map');
  assert.deepEqual(ser.pass('session', map, { dirty: new Set(['zz']) }).removed.sort(), ['a', 'zz']);
  map.set('c', { n: 1n });
  const bad = ser.pass('session', map, { dirty: new Set(['c']) });
  assert.deepEqual(bad.failed, ['c']);
  // A dirty id that is not a string cannot be a record id: it is not reported as removed.
  assert.deepEqual(ser.pass('session', new Map(), { dirty: new Set([42, 'x']) }).removed.sort(), ['a', 'b', 'x']);
});

// A fake slow async sink built on the shared write cycle, as a database sink will be: records live in `db` (kind -> id ->
// JSON text), writeOnce applies a pass after a delay, optionally failing. It runs the same contract as the file store.
function fakeAsyncBackend({ delayMs = 5, debounceMs = 10 } = {}) {
  const db = Object.fromEntries(Object.keys(core.KIND).map((kind) => [kind, new Map()]));
  db.version = 1;
  const probe = { entered: 0, concurrent: 0, maxConcurrent: 0, writes: 0, fail: false };
  const opened = [];

  function open(clock) {
    const log = capture();
    const data = core.createData();
    const cycle = core.createWriteCycle({
      serialiser: core.createSerialiser(log), sources: data.sources, log, clock, debounceMs,
      async writeOnce({ upserts, removed }) {
        probe.entered++; probe.concurrent++; probe.maxConcurrent = Math.max(probe.maxConcurrent, probe.concurrent);
        try {
          await new Promise((r) => setTimeout(r, delayMs));
          if (probe.fail) throw new Error('fake backend down');
          for (const kind of Object.keys(upserts)) {
            for (const [id, str] of upserts[kind]) db[kind].set(id, str);
            for (const id of removed[kind]) db[kind].delete(id);
          }
          probe.writes++;
          return true;
        } finally { probe.concurrent--; }
      },
    });
    const store = {
      ...cycle.api, kind: 'fake-async', state: data.state, log, isSkipped: data.isSkipped,
      load() {
        const doc = { schemaVersion: db.version };
        for (const [kind, def] of Object.entries(core.KIND)) {
          const recs = [...db[kind]].map(([id, str]) => [id, JSON.parse(str)]);
          if (def.singleton) { if (recs.length) doc[def.key] = recs[0][1]; } else doc[def.key] = Object.fromEntries(recs);
        }
        const parsed = core.parseStoreDoc(doc, log);
        if (parsed.error) throw new StoreError(parsed.error, 'unusable');
        core.applyDoc(data, parsed);
        cycle.setLoaded();
        return data.state;
      },
      resetUsage(day) { Object.assign(data.state.usage, core.emptyUsage(), { day }); cycle.api.saveUsage(); },
    };
    opened.push(store);
    return store;
  }
  return { db, probe, open, opened, debounceMs };
}

runStoreContract('fake async sink', async () => {
  const fake = fakeAsyncBackend();
  const first = fake.open();
  first.load();
  return {
    store: first,
    reopen: async () => { const last = fake.opened[fake.opened.length - 1]; await last.settle(); await last.close(); const s = fake.open(); s.load(); return s; },
    seed: async (docs = {}, version = 1) => {
      for (const s of fake.opened) await s.close();
      fake.db.version = version;
      for (const [kind, def] of Object.entries(core.KIND)) {
        const stored = docs[def.key];
        fake.db[kind] = new Map(def.singleton ? (stored ? [[def.singleton, JSON.stringify(stored)]] : []) : Object.entries(stored || {}).map(([id, v]) => [id, JSON.stringify(v)]));
      }
    },
    preserved: async (id) => fake.db.room.has(id), // a database sink never deletes what it skipped
    cleanup: async () => { for (const s of fake.opened) await s.close(); },
  };
});

test('write cycle: a slow write, then a change and a save, then a settle: never two writes at once, and the newer state wins', async () => {
  const fake = fakeAsyncBackend({ delayMs: 40, debounceMs: 5 });
  const s = fake.open();
  s.load();
  const room = minimalRoom('room0001');
  room.note = 'A';
  s.state.rooms.set('room0001', room);
  s.save('room0001');
  const writeA = s.settle(); // write A is now in flight and has captured note 'A'
  assert.equal(fake.probe.entered, 1);
  room.note = 'B';
  s.save('room0001');
  await sleep(15); // the debounce expires while A is still in flight: the timer must not start a second write
  assert.equal(fake.probe.entered, 1);
  const settleB = s.settle();
  assert.deepEqual(await Promise.all([writeA, settleB]), [true, true]);
  assert.equal(fake.probe.maxConcurrent, 1);
  assert.equal(JSON.parse(fake.db.room.get('room0001')).note, 'B');
  assert.equal(fake.probe.entered, 2);
  await s.close();
});

test('write cycle: a save during a timer-started write is written by the timer after it, with no settle()', async () => {
  const fake = fakeAsyncBackend({ delayMs: 0, debounceMs: 5 });
  const clock = manualClock();
  const s = fake.open(clock);
  s.load();
  const room = minimalRoom('room0001');
  s.state.rooms.set('room0001', room);
  s.save('room0001');
  clock.advance(clock.delays()[0]); // the timer starts write 1
  assert.equal(fake.probe.entered, 1);
  room.note = 'later';
  s.save('room0001'); // during the write: arms the timer
  clock.advance(clock.delays()[0]); // the debounce expires while write 1 is in flight
  assert.equal(fake.probe.entered, 1, 'the timer does not start a second write');
  assert.equal(clock.timers.length, 0);
  while (fake.probe.writes < 1) await sleep(1);
  assert.equal(clock.timers.length, 1, 'the pass that ended re-armed the timer for the leftover mark');
  clock.advance(clock.delays()[0]);
  while (fake.probe.writes < 2) await sleep(1);
  assert.equal(JSON.parse(fake.db.room.get('room0001')).note, 'later');
  assert.equal(fake.probe.maxConcurrent, 1);
  await s.close();
});

test('backoff: debounce doubling to a 30 s cap, a save during it only marks, the log is throttled, and a success resets it', async () => {
  const fake = fakeAsyncBackend({ delayMs: 0, debounceMs: 300 });
  const clock = manualClock();
  const s = fake.open(clock);
  s.load();
  fake.probe.fail = true;
  s.state.rooms.set('room0001', minimalRoom('room0001'));
  s.save('room0001');
  assert.deepEqual(clock.delays(), [300], 'the first write waits the debounce');
  const seen = [];
  const settleFailed = async () => { clock.advance(clock.delays()[0]); await sleep(5); seen.push(clock.delays()[0]); };
  for (let i = 0; i < 9; i++) await settleFailed();
  assert.deepEqual(seen, [300, 600, 1200, 2400, 4800, 9600, 19200, 30000, 30000], 'doubles from the debounce, capped at 30 s');
  assert.equal(s.health().ok, false);
  assert.equal(s.health().failingSince, 1000 + 300, 'the first failure of the streak');
  // A save during the backoff only marks: the one timer stays where it is.
  s.save('room0001');
  s.save('room0001');
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.delays()[0], 30000);
  // Attempts at 1300, 1600, 2200, ... 69400: logged at the first of the streak, then at most once per 30 s cap (39400, 69400).
  assert.equal(s.log.lines.filter((l) => l.event === 'store.write_failed').length, 3);
  fake.probe.fail = false;
  clock.advance(30000);
  await sleep(5);
  assert.equal(s.health().ok, true);
  assert.ok(fake.db.room.has('room0001'));
  s.save('room0001');
  assert.deepEqual(clock.delays(), [300], 'a success resets the backoff');
  await s.close();
});

test('backoff: settle() and persist() do not wait for it, and a failure is logged once per backoff cap, not on every call', async () => {
  const fake = fakeAsyncBackend({ delayMs: 0, debounceMs: 300 });
  const clock = manualClock();
  const s = fake.open(clock);
  s.load();
  fake.probe.fail = true;
  s.state.rooms.set('room0001', minimalRoom('room0001'));
  assert.equal(await s.settle(), false);
  assert.equal(await s.settle(), false); // immediately again: same clock time, inside the step
  assert.equal(await s.persist('room', 'room0001'), false);
  assert.equal(s.log.lines.filter((l) => l.event === 'store.write_failed').length, 1, 'throttled by the step');
  clock.t += 300;
  assert.equal(await s.settle(), false);
  assert.equal(s.log.lines.filter((l) => l.event === 'store.write_failed').length, 1, 'still inside the cap');
  clock.t += 30000;
  assert.equal(await s.settle(), false);
  assert.equal(s.log.lines.filter((l) => l.event === 'store.write_failed').length, 2);
  fake.probe.fail = false;
  assert.equal(await s.persist('room', 'room0001'), true, 'no waiting for the backoff');
  await s.close();
});

test('write cycle: a settle() that finds a timer-started write in flight waits for it and then writes what changed since', async () => {
  const fake = fakeAsyncBackend({ delayMs: 40, debounceMs: 5 });
  const s = fake.open();
  s.load();
  const room = minimalRoom('room0001');
  room.note = 'A';
  s.state.rooms.set('room0001', room);
  s.save('room0001');
  await sleep(20); // the timer has started write A, which is still in flight
  assert.equal(fake.probe.entered, 1);
  assert.equal(fake.db.room.size, 0);
  room.note = 'B';
  s.save('room0001');
  assert.equal(await s.settle(), true);
  assert.equal(JSON.parse(fake.db.room.get('room0001')).note, 'B', 'durable when settle() resolves');
  assert.equal(fake.probe.maxConcurrent, 1);
  await s.close();
});

test('write cycle: three concurrent persist(kind, id) calls make at most two writes, and all resolve true', async () => {
  const fake = fakeAsyncBackend({ delayMs: 20, debounceMs: 5 });
  const s = fake.open();
  s.load();
  await s.settle(); // the first write after load
  const base = fake.probe.entered;
  const room = minimalRoom('room0001');
  s.state.rooms.set('room0001', room);
  const all = [s.persist('room', 'room0001'), s.persist('room', 'room0001'), s.persist('room', 'room0001')];
  assert.deepEqual(await Promise.all(all), [true, true, true]);
  assert.ok(fake.probe.entered - base <= 2, 'writes for three persists: ' + (fake.probe.entered - base));
  assert.equal(fake.probe.maxConcurrent, 1);
  assert.ok(fake.db.room.has('room0001'));
  await s.close();
});

test('parseStoreDoc: a schemaVersion that is not a non-negative integer is ESHAPE, a newer number is EFUTURESCHEMA, a missing one is version 0', () => {
  const room = { a0000001: minimalRoom('a0000001') };
  for (const v of ['1', -1, 0.5, null, {}, NaN]) assert.deepEqual(core.parseStoreDoc({ schemaVersion: v, rooms: room }), { error: 'ESHAPE' }, String(v));
  assert.deepEqual(core.parseStoreDoc({ schemaVersion: 1e9, rooms: room }), { error: 'EFUTURESCHEMA' });
  assert.deepEqual(core.parseStoreDoc({ schemaVersion: 2, rooms: 'x' }), { error: 'EFUTURESCHEMA' }, 'newer wins over a bad shape');
  assert.equal(core.parseStoreDoc({ rooms: room }).version, 0);
  assert.equal(core.parseStoreDoc({ schemaVersion: 1, rooms: room }).version, 1);
  assert.deepEqual(core.parseStoreDoc(null), { error: 'ESHAPE' });
  assert.deepEqual(core.parseStoreDoc({ schemaVersion: 1 }), { error: 'ESHAPE' });
});

test('parseStoreDoc: no rooms stored is a usable empty store; one good room beside bad ones is not EALLSKIPPED', () => {
  const empty = core.parseStoreDoc({ schemaVersion: 1, rooms: {} });
  assert.equal(empty.error, undefined);
  assert.deepEqual(empty.records.room, []);
  assert.deepEqual(empty.records.usage, []);
  assert.equal(empty.partial, false);
  const some = core.parseStoreDoc({ schemaVersion: 1, rooms: { good0001: minimalRoom('good0001'), bad00001: 1, bad00002: null } });
  assert.deepEqual(some.skipped.room, ['bad00001', 'bad00002']);
  assert.equal(some.records.room.length, 1);
});

test('parseStoreDoc: a missing collection is empty and not partial; a non-object one is partial; proto keys and non-objects are dropped, with logs that carry no id', () => {
  const rooms = { good0001: minimalRoom('good0001') };
  const log = capture();
  assert.deepEqual(core.parseStoreDoc({ rooms }, log).records.user, []);
  assert.equal(core.parseStoreDoc({ rooms }, log).partial, false);
  for (const v of [null, [], 'x', 3]) {
    const d = core.parseStoreDoc({ rooms, users: v }, log);
    assert.deepEqual(d.records.user, [], String(v));
    assert.equal(d.partial, true, String(v));
  }
  const raw = JSON.parse('{"ok":{"a":1},"p":{"__proto__":{"x":1}},"c":{"constructor":1},"q":{"prototype":2},"arr":[],"nul":null,"s":"x"}');
  const d = core.parseStoreDoc({ rooms, users: raw }, log);
  assert.deepEqual(d.records.user, [['ok', { a: 1 }]]);
  assert.deepEqual(d.skipped.user, ['p', 'c', 'q', 'arr', 'nul', 's']);
  assert.ok(log.lines.every((l) => l.event === 'store.record_skipped' && Object.keys(l.fields).length === 0 && l.level === 'error'));
  assert.equal(log.lines.length, 4 + 6);
  assert.equal(core.parseStoreDoc({ rooms, users: { a: { b: 1 } } }).partial, false, 'the log is optional');
});

test('write cycle: flush() returns false while a write is in flight and starts none; close() resolves only after that write ended', async () => {
  const fake = fakeAsyncBackend({ delayMs: 40, debounceMs: 5 });
  const s = fake.open();
  s.load();
  s.state.rooms.set('room0001', minimalRoom('room0001'));
  s.save('room0001');
  const inflight = s.settle();
  assert.equal(fake.probe.entered, 1);
  assert.equal(s.flush(), false, 'cannot wait for the write here');
  assert.equal(fake.probe.entered, 1, 'and it started no second write');
  let closed = false;
  const closing = s.close().then(() => { closed = true; });
  await sleep(10);
  assert.equal(closed, false, 'close() waits for the write in flight');
  assert.equal(fake.db.room.size, 0);
  await closing;
  assert.equal(fake.probe.concurrent, 0, 'the write had finished');
  assert.equal(fake.db.room.size, 1, 'and its data landed');
  assert.equal(await inflight, true, 'the settle whose write completed still reports it durable');
});

// Regression: close() during a settle() that has marks left made start() return false without clearing them, so the drain
// loop spun on microtasks for ever. Run in a child so a hang cannot hang the suite.
test('write cycle: a mark made during a write, then close(), lets the settle() in flight resolve (it must not spin)', async () => {
  const { spawnSync } = require('node:child_process');
  const corePath = path.join(ROOT, 'lib', 'store-core');
  const src = `const core = require(${JSON.stringify(corePath)}); const log = { error() {} };
    const c = core.createWriteCycle({ serialiser: core.createSerialiser(log), sources: { room: new Map([['r', { a: 1 }]]) }, log, debounceMs: 5,
      writeOnce: () => new Promise((r) => setTimeout(() => r(true), 30)) });
    c.setLoaded(); const s = c.api.settle(); c.api.save('r'); c.api.close(); s.then(() => process.exit(0));`;
  const r = spawnSync(process.execPath, ['-e', src], { timeout: 3000 });
  assert.equal(r.status, 0, 'the settle() resolved instead of hanging');
});

test('write cycle: a mark made during a write, then close(): the settle() in flight resolves false, because that mark was never written', async () => {
  const fake = fakeAsyncBackend({ delayMs: 20, debounceMs: 5 });
  const s = fake.open();
  s.load();
  const room = minimalRoom('room0001');
  s.state.rooms.set('room0001', room);
  s.save('room0001');
  const settling = s.settle();
  room.note = 'never written';
  s.save('room0001'); // during the write
  const closing = s.close();
  assert.equal(await settling, false);
  await closing;
  assert.equal(JSON.parse(fake.db.room.get('room0001')).note, undefined, 'only the first pass landed');
  assert.equal(fake.probe.entered, 1);
});

test('write cycle: settle(), persist(), flush(), save and saveUsage on a closed store write nothing and resolve false', async () => {
  const fake = fakeAsyncBackend({ delayMs: 0, debounceMs: 5 });
  const s = fake.open();
  s.load();
  await s.close();
  s.state.rooms.set('room0001', minimalRoom('room0001'));
  assert.equal(await s.settle(), false);
  assert.equal(await s.persist('room', 'room0001'), false);
  assert.equal(s.flush(), false);
  s.save('room0001');
  s.saveUsage();
  await sleep(40);
  assert.equal(fake.probe.entered, 0);
  assert.equal(await s.drain(), false);
  assert.throws(() => s.persist('nope', 'x'), /unknown collection kind/, 'an unknown kind throws even closed');
});

test('write cycle: nothing is written before setLoaded(), and a settle() or flush() then is false', async () => {
  let writes = 0;
  const cycle = core.createWriteCycle({ serialiser: core.createSerialiser(capture()), sources: { room: new Map() }, writeOnce() { writes++; return true; }, log: capture(), debounceMs: 5 });
  cycle.api.save('x');
  assert.equal(cycle.api.flush(), false);
  assert.equal(await cycle.api.settle(), false);
  assert.equal(await cycle.api.persist('room', 'x'), false);
  await sleep(30);
  assert.equal(writes, 0);
  cycle.setLoaded();
  assert.equal(cycle.api.flush(), true);
  assert.equal(writes, 1);
  await cycle.api.close();
});

test('write cycle: persist(kind, id) is false when that id could not be serialised, true for a sibling, and true again once it can', async () => {
  const fake = fakeAsyncBackend({ delayMs: 0, debounceMs: 5 });
  const s = fake.open();
  s.load();
  const bad = minimalRoom('bad00001');
  bad.n = 1n; // JSON.stringify throws
  s.state.rooms.set('bad00001', bad);
  s.state.rooms.set('good0001', minimalRoom('good0001'));
  assert.equal(await s.persist('room', 'bad00001'), false);
  assert.ok(fake.db.room.has('good0001'), 'the write itself succeeded for the sibling');
  assert.equal(fake.db.room.has('bad00001'), false);
  assert.equal(await s.persist('room', 'good0001'), true);
  assert.equal(await s.persist('room', 'bad00001'), false);
  delete bad.n;
  assert.equal(await s.persist('room', 'bad00001'), true);
  assert.ok(fake.db.room.has('bad00001'));
  await s.close();
});

test('write cycle: saveUsage() alone arms one write that carries the live usage, and a failed one marks it again', async () => {
  const fake = fakeAsyncBackend({ delayMs: 0, debounceMs: 5 });
  const s = fake.open();
  s.load();
  await s.settle(); // the first write after load (every kind starts dirty)
  const base = fake.probe.entered;
  const usage = () => JSON.parse(fake.db.usage.get('today'));
  s.state.usage.total = 7;
  s.saveUsage();
  s.saveUsage();
  await sleep(40);
  assert.equal(fake.probe.entered, base + 1, 'coalesced');
  assert.equal(usage().total, 7);
  fake.probe.fail = true;
  s.state.usage.total = 8;
  s.saveUsage();
  await sleep(40);
  assert.equal(usage().total, 7, 'the failed write stored nothing');
  fake.probe.fail = false;
  assert.equal(await s.settle(), true, 'the mark was restored, so settle writes it');
  assert.equal(usage().total, 8);
  await s.close();
});

test('write cycle: a synchronous writeOnce that returns something other than true, or throws, is a failure that keeps the marks', async () => {
  const log = capture();
  let mode = 'falsy';
  const written = [];
  const cycle = core.createWriteCycle({
    serialiser: core.createSerialiser(log), sources: { room: new Map([['r', { a: 1 }]]) }, log, debounceMs: 1000,
    writeOnce({ upserts }) { if (mode === 'throw') throw new Error('boom'); if (mode === 'ok') { written.push(upserts.room.length); return true; } return undefined; },
  });
  cycle.setLoaded();
  assert.equal(cycle.api.flush(), false);
  mode = 'throw';
  assert.equal(cycle.api.flush(), false);
  assert.equal(cycle.api.health().ok, false);
  mode = 'ok';
  assert.equal(cycle.api.flush(), true);
  assert.deepEqual(written, [1], 'the record was still marked after two failures');
  assert.equal(cycle.api.health().ok, true);
  assert.equal(cycle.api.health().failingSince, null);
  await cycle.api.close();
});

test('write cycle: an async writeOnce that resolves to anything but true is a failure: nothing is committed and the marks come back', async () => {
  const log = capture();
  let result = false;
  const writes = [];
  const cycle = core.createWriteCycle({
    serialiser: core.createSerialiser(log), sources: { room: new Map([['r', { a: 1 }]]) }, log, debounceMs: 1000,
    writeOnce: async ({ upserts }) => { writes.push(upserts.room.length); return result; },
  });
  cycle.setLoaded();
  assert.equal(await cycle.api.settle(), false);
  assert.equal(cycle.api.health().ok, false);
  result = 'yes';
  assert.equal(await cycle.api.settle(), false, 'truthy is not true');
  result = true;
  assert.equal(await cycle.api.settle(), true);
  assert.deepEqual(writes, [1, 1, 1], 'the record stayed uncommitted, so it was in every pass');
  assert.equal(cycle.api.health().ok, true);
  await cycle.api.close();
});

// A cycle over one room map with a counting synchronous writeOnce, on the manual clock.
function syncCycle({ results = [], clock = manualClock(), serialiser, log = capture(), debounceMs = 10, onWrite } = {}) {
  const c = { writes: 0, clock, log };
  c.cycle = core.createWriteCycle({
    serialiser: serialiser || core.createSerialiser(log), sources: { room: new Map([['r', { a: 1 }]]) }, log, clock, debounceMs,
    writeOnce() { c.writes++; if (onWrite) onWrite(c); return results.length ? results.shift() : true; },
  });
  c.cycle.setLoaded();
  return c;
}

test('write cycle: with nothing marked, not forced and not failing, a pass writes nothing and counts as durable', async () => {
  const c = syncCycle();
  assert.equal(c.cycle.api.flush(), true);
  assert.equal(c.writes, 1, 'the first write after load');
  assert.equal(c.cycle.api.flush(), true, 'true on a healthy idle store');
  assert.equal(await c.cycle.api.settle(), true);
  assert.equal(c.writes, 1);
  assert.equal(await c.cycle.api.persist('room'), true, 'a persist with no id is forced');
  assert.equal(c.writes, 2);
  c.cycle.api.save('r');
  assert.equal(c.cycle.api.flush(), true);
  assert.equal(c.writes, 3, 'a mark is written');
});

test('write cycle: a timer armed during a pass cannot fire a stray pass after that pass was taken over by a settle()', async () => {
  const fake = fakeAsyncBackend({ delayMs: 10, debounceMs: 50 });
  const clock = manualClock();
  const s = fake.open(clock);
  s.load();
  const room = minimalRoom('room0001');
  s.state.rooms.set('room0001', room);
  s.save('room0001');
  const settling = s.settle(); // pass 1 is in flight
  room.note = 'B';
  s.save('room0001'); // arms a timer during the pass
  assert.equal(await settling, true); // the settle runs pass 2 for that mark
  const entered = fake.probe.entered;
  assert.equal(clock.timers.length, 0, 'no timer left over');
  clock.advance(1e6);
  await sleep(30);
  assert.equal(fake.probe.entered, entered, 'no stray pass');
  await s.close();
});

test('write cycle: a failed pass always arms the retry, even if it took no marks, and a recovered sink clears the failure by itself', async () => {
  const c = syncCycle({ results: [true, false, true] });
  assert.equal(c.cycle.api.flush(), true);
  assert.equal(await c.cycle.api.persist('room'), false, 'a forced pass, which failed; it took no marks');
  assert.equal(c.cycle.api.health().ok, false);
  assert.deepEqual(c.clock.delays(), [100], 'the retry is armed (the base is at least 100 ms)');
  c.clock.advance(100); // no marks, but failing: the pass still runs writeOnce
  assert.equal(c.writes, 3);
  assert.deepEqual(c.cycle.api.health(), { ok: true, failingSince: null });
  assert.deepEqual(c.clock.delays(), [], 'and nothing is left armed');
});

test('write cycle: the usage is rewritten on every pass, so an unmarked in-place change to it still reaches the backend', async () => {
  const fake = fakeAsyncBackend({ delayMs: 0, debounceMs: 5 });
  const s = fake.open();
  s.load();
  await s.settle();
  s.state.usage.byUser.u1 = 5; // no saveUsage()
  s.state.rooms.set('room0001', minimalRoom('room0001'));
  s.save('room0001');
  await s.settle();
  assert.deepEqual(JSON.parse(fake.db.usage.get('today')).byUser, { u1: 5 });
  await s.close();
});

test('the usage kind: an unmarked in-place change reaches the file with the next write, mark is not public, and a singleton takes no other id', async (t) => {
  const s = setup(t);
  s.store.load();
  assert.equal(s.store.flush(), true);
  s.store.state.usage.byUser.u1 = 5;
  s.store.state.rooms.set('okroom01', minimalRoom('okroom01'));
  s.store.save('okroom01');
  assert.equal(s.store.flush(), true);
  assert.deepEqual(s.disk().usage.byUser, { u1: 5 });
  assert.equal('mark' in s.store, false);
  assert.throws(() => s.store.persist('usage', 'other'), /singleton/);
  assert.equal(await s.store.persist('usage', 'today'), true);
});

test('write cycle: a logger that throws cannot break a failing async write: no rejection, the settle() resolves, the cycle recovers', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const clock = manualClock();
    const log = { info() {}, warn() {}, error() { throw new Error('the logger is down'); } };
    let fail = true;
    const cycle = core.createWriteCycle({
      serialiser: core.createSerialiser(log), sources: { room: new Map([['r', { a: 1 }]]) }, log, clock, debounceMs: 10,
      writeOnce: async () => { await sleep(1); return !fail; },
    });
    cycle.setLoaded();
    cycle.api.save('r');
    clock.advance(10); // the timer starts a pass that fails
    await sleep(15);
    clock.t += 1000; // past the log throttle, so this failure is logged too
    assert.equal(await cycle.api.settle(), false);
    assert.equal(cycle.api.health().ok, false);
    fail = false;
    assert.equal(await cycle.api.settle(), true, 'inflight cleared, so a new pass could run');
    assert.equal(cycle.api.flush(), true, 'and nothing is still in flight');
    await sleep(5);
    assert.deepEqual(unhandled, []);
    await cycle.api.close();
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});

test('write cycle: a pass that throws out of finish() in a timer is contained: no unhandled rejection (async) and no uncaught throw (sync)', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const log = capture();
    const base = core.createSerialiser(log);
    const broken = { ...base, commit() { throw new Error('commit broke'); } };
    // async: finish() rejects the pass promise, which nobody awaits
    const clock = manualClock();
    const a = core.createWriteCycle({ serialiser: broken, sources: { room: new Map([['r', { a: 1 }]]) }, log, clock, debounceMs: 10, writeOnce: async () => true });
    a.setLoaded();
    a.api.save('r');
    clock.advance(10); // a pass starts
    a.api.save('r');
    clock.advance(10); // the timer fires while it is in flight: nothing to do
    await sleep(20);
    assert.deepEqual(unhandled, [], 'the async rejection was caught');
    assert.equal(clock.timers.length, 1, 'the mark made during the pass is armed even though finish() threw');
    // sync: finish() throws inside the timer callback
    const c = syncCycle({ serialiser: broken });
    c.cycle.api.save('r');
    assert.doesNotThrow(() => c.clock.advance(10));
    assert.equal(c.writes, 1);
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});

test('write cycle: after a recovery the backoff starts over: the next delay is the debounce, the step is the base again, and the first failure logs', () => {
  const c = syncCycle({ results: [false, true, false] });
  const fails = () => c.log.lines.filter((l) => l.event === 'store.write_failed').length;
  assert.equal(c.cycle.api.flush(), false);
  assert.equal(fails(), 1);
  assert.deepEqual(c.clock.delays(), [100]);
  assert.equal(c.cycle.api.flush(), true, 'recovered at once, with no time passed: the old backoff deadline is still in the future');
  c.cycle.api.save('r');
  assert.deepEqual(c.clock.delays(), [10], 'a mark after the recovery waits only the debounce');
  c.clock.advance(10);
  assert.equal(c.cycle.api.health().ok, false);
  assert.deepEqual(c.clock.delays(), [100], 'the step restarted from the base, not doubled');
  assert.equal(fails(), 2, 'the first failure of a new streak logs even inside the previous throttle window');
});

test('write cycle: no timer is pending after close(), and a save() after close() arms none', () => {
  const c = syncCycle();
  c.cycle.api.save('r');
  assert.equal(c.clock.timers.length, 1);
  c.cycle.api.close();
  assert.equal(c.clock.timers.length, 0);
  c.cycle.api.save('r');
  c.cycle.api.collection('room').save('r');
  assert.equal(c.clock.timers.length, 0);
  assert.equal(c.cycle.api.flush(), false);
});

test('write cycle: a debounce of 0 cannot make a hot retry loop, and a long streak never reaches NaN', () => {
  const c = syncCycle({ debounceMs: 0, results: Array(2000).fill(false) });
  assert.equal(c.cycle.api.flush(), false);
  assert.deepEqual(c.clock.delays(), [100]);
  for (let i = 0; i < 1500; i++) c.cycle.api.flush();
  assert.deepEqual(c.clock.delays(), [30000]);
});

test('write cycle: settle() gives up after 50 passes when marks keep arriving, instead of spinning', async () => {
  const c = syncCycle({ onWrite: (x) => x.cycle.api.save('r') });
  assert.equal(await c.cycle.api.settle(), false);
  assert.equal(c.writes, 50);
});

// ---- Gate 2 batch: parseStoreDoc option, seeded cache, id validation, shared helpers ----
test('parseStoreDoc: allSkippedFatal false keeps going with every room skipped; the default refuses it', () => {
  const raw = { schemaVersion: 1, rooms: { bad00001: { id: 'bad00001' } } };
  assert.equal(core.parseStoreDoc(raw).error, 'EALLSKIPPED');
  const doc = core.parseStoreDoc(raw, undefined, { allSkippedFatal: false });
  assert.equal(doc.error, undefined);
  assert.deepEqual(doc.skipped.room, ['bad00001']);
  assert.deepEqual(doc.records.room, []);
});

test('serialiser: a record whose text equals the seeded one is not upserted again, and the snapshot still holds it', () => {
  const ser = core.createSerialiser(capture());
  const room = minimalRoom('room0001');
  const map = new Map([['room0001', room], ['room0002', minimalRoom('room0002')]]);
  ser.seed('room', 'room0001', core.KIND.room.encode(room));
  const res = ser.pass('room', map, { all: true });
  assert.deepEqual(res.upserts.map(([id]) => id), ['room0002']);
  assert.deepEqual(ser.snapshot('room', map, res).map(([id]) => id), ['room0001', 'room0002']);
  room.note = 'changed';
  assert.deepEqual(ser.pass('room', map, { all: true }).upserts.map(([id]) => id), ['room0001', 'room0002']);
  assert.deepEqual(ser.pass('room', new Map(), { all: true }).removed, ['room0001']);
});

test('record ids: 1 to 256 characters with no NUL; anything else throws at save() and persist(), and a bad map key is skipped and logged', async (t) => {
  const s = setup(t);
  s.store.load();
  for (const bad of ['', 'x'.repeat(257), 'a' + String.fromCharCode(0) + 'b', 5, null, {}]) {
    assert.throws(() => s.store.save(bad), /invalid record id/, String(bad));
    assert.throws(() => s.store.collection('user').save(bad), /invalid record id/, String(bad));
    assert.throws(() => s.store.persist('room', bad), /invalid record id/, String(bad));
  }
  s.store.save('x'.repeat(256));
  s.store.state.rooms.set('a' + String.fromCharCode(0) + 'b', minimalRoom('a'));
  s.store.state.rooms.set('okroom01', minimalRoom('okroom01'));
  s.store.save();
  assert.equal(s.store.flush(), true);
  assert.deepEqual(Object.keys(s.disk().rooms), ['okroom01']);
  assert.ok(s.log.events().includes('store.record_bad_id'));
});

test('safeCode keeps only an E-code, and resetUsage empties the counters under the new day and saves', () => {
  assert.equal(core.safeCode({ code: 'ENOENT' }), 'ENOENT');
  assert.equal(core.safeCode({ code: 'enoent' }), null);
  assert.equal(core.safeCode({ code: 'SECRET text' }, 'EIO'), 'EIO');
  assert.equal(core.safeCode(null, 'EIO'), 'EIO');
  const data = core.createData();
  data.state.usage.total = 4; data.state.usage.byUser.x = 1;
  let saved = 0;
  core.resetUsage(data, { saveUsage: () => { saved++; } }, '2026-10-04');
  assert.deepEqual(plain(data.state.usage), { day: '2026-10-04', total: 0, byIp: {}, failedByIp: {}, byUser: {} });
  assert.equal(saved, 1);
});

test('every migration is idempotent: applying each step twice gives what once gives, for a v0 room and a current-shape room', () => {
  assert.ok(core.MIGRATIONS.length >= 1);
  const v0 = () => { const r = minimalRoom('v0room001'); delete r.seats.A.mode; delete r.seats.B.mode; r.demo = 'yes'; return r; };
  const current = () => { const r = minimalRoom('current01'); r.demo = true; r.note = 'x'; return r; };
  for (const make of [v0, current]) {
    for (const step of core.MIGRATIONS) {
      const once = make();
      step(once);
      const twice = make();
      step(twice);
      step(twice);
      assert.deepEqual(twice, once, step.name);
    }
  }
  const r = v0();
  for (const step of core.MIGRATIONS) step(r);
  assert.equal(r.seats.A.mode, 'builtin');
  assert.equal(r.demo, false);
});

test('a lone surrogate in a record id is refused, a proper pair is not', async (t) => {
  const s = setup(t);
  s.store.load();
  const hi = String.fromCharCode(0xd83d);
  const lo = String.fromCharCode(0xde00);
  for (const bad of ['a' + hi, hi + 'a', 'a' + lo, lo, lo + hi, 'a' + hi + hi + lo + lo]) {
    assert.throws(() => s.store.save(bad), /invalid record id/, JSON.stringify(bad));
  }
  s.store.save('a' + hi + lo + 'b'); // a pair is a character
  s.store.state.rooms.set('x' + hi, minimalRoom('lone'));
  s.store.save();
  assert.equal(s.store.flush(), true);
  assert.ok(!Object.keys(s.disk().rooms).includes('x' + hi));
  assert.ok(s.log.events().includes('store.record_bad_id'));
});

test('write cycle: lose(at) closes for good and keeps health not ok from `at` (the earlier of that and a write failure), and a lost store logs no write failure', async () => {
  const c = syncCycle({ results: [true, false] });
  assert.equal(c.cycle.api.flush(), true);
  await c.cycle.api.lose(5000);
  assert.deepEqual(c.cycle.api.health(), { ok: false, failingSince: 5000 });
  assert.equal(c.cycle.api.flush(), false, 'closed');
  assert.equal(c.writes, 1);
  // a write already failing earlier keeps the earlier time
  const d = syncCycle({ results: [false] });
  assert.equal(d.cycle.api.flush(), false);
  const since = d.cycle.api.health().failingSince;
  await d.cycle.api.lose(since + 9000);
  assert.equal(d.cycle.api.health().failingSince, since);
  // a write that fails after the loss is not logged: the loss was
  const e = syncCycle({ results: [], serialiser: undefined });
  let release;
  const fake = core.createWriteCycle({
    serialiser: core.createSerialiser(e.log), sources: { room: new Map([['r', { a: 1 }]]) }, log: e.log, clock: e.clock, debounceMs: 10,
    writeOnce: () => new Promise((resolve, reject) => { release = () => reject(new Error('late')); }),
  });
  fake.setLoaded();
  const p = fake.api.settle();
  const lost = fake.api.lose(7000); // close waits for the write in flight
  release();
  assert.equal(await p, false);
  await lost;
  assert.equal(e.log.lines.filter((l) => l.event === 'store.write_failed').length, 0);
  assert.equal(fake.api.health().ok, false);
});

test('decodeStoreText: a BOM is ignored, text that is not JSON is EPARSE, and the rest is parseStoreDoc', () => {
  const doc = JSON.stringify({ schemaVersion: 1, rooms: { room0001: minimalRoom('room0001') } });
  assert.equal(core.decodeStoreText('\uFEFF' + doc).records.room.length, 1);
  assert.equal(core.decodeStoreText('{"rooms": nope').error, 'EPARSE');
  assert.equal(core.decodeStoreText('').error, 'EPARSE');
  assert.equal(core.decodeStoreText('[]').error, 'ESHAPE');
  assert.equal(core.decodeStoreText('{"schemaVersion":99,"rooms":{}}').error, 'EFUTURESCHEMA');
  assert.equal(core.corruptPath('/d/rooms.json', Date.UTC(2026, 9, 3, 1, 2, 3, 4)), '/d/rooms.json.corrupt-2026-10-03T01-02-03.004Z');
});
