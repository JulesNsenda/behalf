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

const FIXTURE = path.join(ROOT, 'test-support', 'fixtures', 'rooms.v0.json');
const QUARANTINE = /^rooms\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;
const PARTIAL = /^rooms\.json\.partial-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;

function capture() {
  const lines = [];
  const mk = (level) => (event, fields, err) => lines.push({ level, event, fields: fields || {}, err });
  return { lines, info: mk('info'), warn: mk('warn'), error: mk('error'), events: () => lines.map((l) => l.event) };
}

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
  return { dir, file, log, store, names: () => realFs.readdirSync(dir).sort(), disk: () => JSON.parse(realFs.readFileSync(file, 'utf8')) };
}

const fixture = () => JSON.parse(realFs.readFileSync(FIXTURE, 'utf8'));
const minimalRoom = (id) => ({ id, seats: { A: { mode: 'builtin', token: 't' + id + 'a' }, B: { mode: 'builtin', token: 't' + id + 'b' } }, ledger: [], envelopes: [], claims: {}, demo: false });
const withFs = (over) => Object.assign({}, realFs, over);
const plain = (v) => JSON.parse(JSON.stringify(v));
// An injected fs that counts the opens of a store temp file, i.e. the writes.
function countOpens() {
  const c = { n: 0 };
  c.fs = withFs({ openSync(...a) { if (/\.tmp-/.test(String(a[0]))) c.n++; return realFs.openSync(...a); } });
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
  assert.deepEqual(plain(store2.state.usage), fixture().usage);
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
  assert.deepEqual(plain(s.store.state.usage), { day: 'd', total: 2, byIp: { x: 2 } });
});

test('no file: empty state, and the data directory is created', (t) => {
  const s = setup(t);
  const st = s.store.load();
  assert.equal(st.rooms.size, 0);
  assert.deepEqual(plain(st.usage), { day: '', total: 0, byIp: {} });
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
