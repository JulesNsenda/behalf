'use strict';
// scripts/export-rooms.js against a real Postgres: the rollback export. Skipped unless PG_TEST_URL is set. It has a database of
// its own (the Postgres store takes an advisory lock per database, and node --test runs files side by side).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createPgStore } = require('../lib/store-pg');
const { createStore } = require('../lib/store');
const { StoreError } = require('../lib/store-core');
const { exportRooms, docText } = require('../scripts/export-rooms');
const { minimalRoom, capture } = require('../test-support/store-contract');
const { mkTmp, rmTmp } = require('../test-support/server');
const { ROOT } = require('../test-support/paths');
const { PG_URL, scratchDatabase, withClient } = require('../test-support/pg');

const SCRIPT = path.join(ROOT, 'scripts', 'export-rooms.js');
const DB = { timeout: 60000, skip: !PG_URL };
const db = PG_URL ? scratchDatabase('behalf_export_test') : null;
const plain = (v) => JSON.parse(JSON.stringify(v));
const mapOf = (m) => plain(Object.fromEntries(m));
const rows = (sql, params) => withClient(db.url, (c) => c.query(sql, params)).then((r) => r.rows);

if (!PG_URL) test('the export tests (skipped: PG_TEST_URL is not set)', { skip: true }, () => {});
else { before(() => db.create()); after(() => db.drop()); }

// A pg store with rooms, usage and accounts in it, settled and (unless keepOpen) closed.
async function seeded({ keepOpen = false } = {}) {
  await db.reset();
  const s = createPgStore({ url: db.url, log: capture(), debounceMs: 20 });
  await s.load();
  for (const id of ['room0001', 'room0002']) { const r = minimalRoom(id); r.note = 'n-' + id; s.state.rooms.set(id, r); s.save(id); }
  Object.assign(s.state.usage, { day: '2026-10-03', total: 4, byIp: { '1.2.3.4': 2 }, byUser: { u1: 2 } });
  s.saveUsage();
  const accounts = { user: { u1: { id: 'u1', login: 'ada-lovelace-login' } }, session: { s1: { user: 'u1', at: 1 } }, agentkey: { k1: { user: 'u1', hash: 'h' } }, aiaccess: { u1: { status: 'granted', note: '', requestedAt: null, decidedAt: 1 } } };
  for (const [kind, recs] of Object.entries(accounts)) {
    const col = s.collection(kind);
    for (const [id, rec] of Object.entries(recs)) { col.map.set(id, rec); col.save(id); }
  }
  assert.equal(await s.settle(), true);
  if (!keepOpen) await s.close();
  return s;
}

function snapshot(store) {
  return {
    rooms: mapOf(store.state.rooms), usage: plain(store.state.usage),
    users: mapOf(store.collection('user').map), sessions: mapOf(store.collection('session').map), agentkeys: mapOf(store.collection('agentkey').map),
    aiaccess: mapOf(store.collection('aiaccess').map),
  };
}

test('the export loads in the file store as the same rooms, usage and accounts, while the app still holds the database lock', DB, async (t) => {
  const live = await seeded({ keepOpen: true }); // holds the advisory lock: the export must not need it
  const dir = mkTmp('export-');
  t.after(() => rmTmp(dir));
  const before = await rows('SELECT kind, id, doc, updated_at FROM behalf_records ORDER BY kind, id');
  const out = path.join(dir, 'rooms.json');
  const res = await exportRooms({ url: db.url, out });
  assert.deepEqual(res, { counts: { room: 2, usage: 1, user: 1, session: 1, agentkey: 1, aiaccess: 1 }, skipped: 0 });
  assert.deepEqual(await rows('SELECT kind, id, doc, updated_at FROM behalf_records ORDER BY kind, id'), before, 'the table is untouched');
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(doc), ['schemaVersion', 'rooms', 'usage', 'users', 'sessions', 'agentkeys', 'aiaccess']);
  assert.equal(doc.schemaVersion, 1);
  const file = createStore({ file: out, log: capture() });
  file.load();
  assert.deepEqual(snapshot(file), snapshot(live));
  assert.equal(file.state.rooms.get('room0001').note, 'n-room0001');
  await live.close();
});

test('with no accounts the export has only schemaVersion, rooms and usage, like a file the file store wrote', DB, async (t) => {
  await db.reset();
  const s = createPgStore({ url: db.url, log: capture(), debounceMs: 20 });
  await s.load();
  s.state.rooms.set('room0001', minimalRoom('room0001'));
  s.save('room0001');
  assert.equal(await s.settle(), true);
  await s.close();
  const dir = mkTmp('export-');
  t.after(() => rmTmp(dir));
  const out = path.join(dir, 'rooms.json');
  await exportRooms({ url: db.url, out });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(out, 'utf8'))), ['schemaVersion', 'rooms', 'usage']);
  // The same data written by the file store itself is the same file.
  const f = createStore({ file: path.join(dir, 'own.json'), log: capture() });
  f.load();
  f.state.rooms.set('room0001', minimalRoom('room0001'));
  Object.assign(f.state.usage, plain(JSON.parse(fs.readFileSync(out, 'utf8')).usage));
  f.save();
  f.saveUsage();
  assert.equal(f.flush(), true);
  assert.equal(fs.readFileSync(path.join(dir, 'own.json'), 'utf8'), fs.readFileSync(out, 'utf8'));
});

test('it refuses to overwrite a file, leaving it as it was, and an unusable row is left out and counted', DB, async (t) => {
  await seeded();
  const dir = mkTmp('export-');
  t.after(() => rmTmp(dir));
  const out = path.join(dir, 'rooms.json');
  fs.writeFileSync(out, 'precious');
  await assert.rejects(exportRooms({ url: db.url, out }), (e) => e instanceof StoreError && e.code === 'EEXIST');
  assert.equal(fs.readFileSync(out, 'utf8'), 'precious');
  await rows("INSERT INTO behalf_records (kind, id, doc) VALUES ('room', 'bad', '{nope')");
  const out2 = path.join(dir, 'two.json');
  const res = await exportRooms({ url: db.url, out: out2 });
  assert.equal(res.skipped, 1);
  assert.equal(res.counts.room, 2);
  assert.equal(JSON.parse(fs.readFileSync(out2, 'utf8')).rooms.bad, undefined);
});

test('a table with no metadata row, or from a newer schema, is refused and nothing is written', DB, async (t) => {
  await seeded();
  const dir = mkTmp('export-');
  t.after(() => rmTmp(dir));
  const meta = (await rows("SELECT doc FROM behalf_records WHERE kind = 'meta'"))[0].doc;
  await rows("UPDATE behalf_records SET doc = '{\"version\":99}' WHERE kind = 'meta'");
  await assert.rejects(exportRooms({ url: db.url, out: path.join(dir, 'a.json') }), (e) => e.code === 'EFUTURESCHEMA');
  await rows("DELETE FROM behalf_records WHERE kind = 'meta'");
  await assert.rejects(exportRooms({ url: db.url, out: path.join(dir, 'b.json') }), (e) => e.code === 'ESHAPE');
  await rows("INSERT INTO behalf_records (kind, id, doc) VALUES ('meta', 'schema', $1)", [meta]);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a table still at an older schema version is exported at that version, and the file store migrates its rooms on load', DB, async (t) => {
  await seeded();
  const dir = mkTmp('export-');
  t.after(() => rmTmp(dir));
  await rows("UPDATE behalf_records SET doc = '{\"version\":0,\"epoch\":\"e\"}' WHERE kind = 'meta'");
  await rows("UPDATE behalf_records SET doc = $1 WHERE kind = 'room' AND id = 'room0001'", [JSON.stringify({ id: 'room0001', seats: { A: { token: 'a' }, B: { token: 'b' } }, ledger: [], envelopes: [], claims: {} })]);
  const out = path.join(dir, 'rooms.json');
  await exportRooms({ url: db.url, out });
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).schemaVersion, 0);
  const file = createStore({ file: out, log: capture() });
  file.load();
  assert.equal(file.state.rooms.get('room0001').seats.A.mode, 'builtin', 'migrated from version 0');
});

test('docText leaves an old meta version in the file, so the file store migrates the rooms', () => {
  const { text } = docText([{ kind: 'room', id: 'r', doc: '{"id":"r"}' }], 0);
  assert.equal(text, '{"schemaVersion":0,"rooms":{"r":{"id":"r"}}}');
});

test('the command line prints counts, never the URL or a record, and exits 1 with a code on failure', DB, async (t) => {
  await seeded();
  const dir = mkTmp('export-');
  t.after(() => rmTmp(dir));
  const run = (args, url) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  const out = path.join(dir, 'rooms.json');
  const ok = run([out], db.url);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `exported 2 rooms, 1 users, 1 sessions, 1 agent keys to ${out}\n`);
  const text = fs.readFileSync(out, 'utf8');
  assert.ok(text.includes('troom0001a') && text.includes('ada-lovelace-login'), 'the file does hold the records');
  for (const needle of ['troom0001a', 'ada-lovelace-login', 'behalf:behalf', 'localhost']) assert.ok(!(ok.stdout + ok.stderr).includes(needle), needle);
  const again = run([out], db.url);
  assert.equal(again.status, 1);
  assert.equal(again.stderr, 'export failed: EEXIST\n');
  const bad = run([path.join(dir, 'x.json')], 'postgres://nobody:secretpw@127.0.0.1:1/nowhere');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^export failed: [A-Z0-9_]+\n$/);
  assert.ok(!(bad.stdout + bad.stderr).includes('secretpw'));
  assert.equal(fs.existsSync(path.join(dir, 'x.json')), false);
  assert.equal(run([], db.url).status, 2);
  assert.equal(run([out, 'extra'], db.url).status, 2);
  const nourl = run([path.join(dir, 'y.json')], '');
  assert.equal(nourl.status, 1);
  assert.equal(nourl.stderr, 'export failed: ENOURL\n');
});
