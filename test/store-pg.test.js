'use strict';
// lib/store-pg against a real Postgres: the shared contract suite plus the lock, the import, skipped rows, failed and slow
// writes, drain, migration, and bootApp / index.js with DATABASE_URL. Skipped unless PG_TEST_URL is set, e.g.
//   PG_TEST_URL=postgres://behalf:behalf@localhost:55432/behalf_test npm test
// Every test drops and recreates behalf_records, so the database must be a scratch one. All of them live in this one file:
// the advisory lock is per database, so two test files would fight over it when node --test runs them side by side.
// Tests that need `pg` but no server (a closed port) run whenever pg is installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createPgStore, LOCK_CLASS, STATEMENT_MS, WATCHDOG_SLACK_MS, warnsNoTls, pgError, classify } = require('../lib/store-pg');
const { StoreError } = require('../lib/store-core');
const { createLog } = require('../lib/log');
const { bootApp } = require('../lib/app');
const { loadConfig, loadSecrets } = require('../lib/config');
const { runStoreContract, minimalRoom, capture } = require('../test-support/store-contract');
const { fakeProxy } = require('../test-support/app');
const { mkTmp, rmTmp, spawnIndex } = require('../test-support/server');
const { waitFor, sleep } = require('../test-support/http');
const { ROOT } = require('../test-support/paths');

const { PG_URL: URL_, pgQuery: q, withBlocker, assertScratch, dropTable } = require('../test-support/pg');
const hasPg = (() => { try { require.resolve('pg'); return true; } catch (e) { return false; } })();
const T = { timeout: 60000 };
const DB = { ...T, skip: !URL_ };

if (!URL_) test('the Postgres store tests (skipped: PG_TEST_URL is not set)', { skip: true }, () => {});

// A harness: stores it opens (all closed by cleanup), the capture logger, and the data helpers.
async function harness(opts = {}) {
  await assertScratch();
  await dropTable();
  const log = capture();
  const opened = [];
  let last = null;
  const open = async (more) => {
    const s = createPgStore({ url: URL_, log, debounceMs: 25, ...opts, ...more });
    opened.push(s);
    await s.load();
    last = s;
    return s;
  };
  const insert = async (kind, id, doc) => q('INSERT INTO behalf_records (kind, id, doc) VALUES ($1, $2, $3) ON CONFLICT (kind, id) DO UPDATE SET doc = EXCLUDED.doc', [kind, id, typeof doc === 'string' ? doc : JSON.stringify(doc)]);
  return {
    log, open, insert,
    last: () => last,
    cleanup: async () => { for (const s of opened) await s.close(); await dropTable(); },
    // Replaces the data with doc ({ rooms, usage, users, sessions, agentkeys }, each optional) under meta version `version`.
    seed: async (doc, version = 1) => {
      await last.close();
      await q('TRUNCATE behalf_records');
      await insert('meta', 'schema', { version });
      const kinds = { rooms: 'room', users: 'user', sessions: 'session', agentkeys: 'agentkey' };
      for (const [key, kind] of Object.entries(kinds)) for (const [id, rec] of Object.entries(doc[key] || {})) await insert(kind, id, rec);
      if (doc.usage) await insert('usage', 'today', doc.usage);
    },
  };
}

// A test with a harness that is cleaned up afterwards.
const withHarness = (title, fn, opts) => test(title, DB, async (t) => {
  const h = await harness(opts);
  t.after(h.cleanup);
  await fn(h, t);
});

if (URL_) {
  runStoreContract('postgres', async () => {
    const h = await harness();
    const store = await h.open();
    return {
      store,
      reopen: async () => { await h.last().settle(); await h.last().close(); return h.open(); },
      seed: h.seed,
      cleanup: h.cleanup,
      preserved: async (id) => (await q("SELECT 1 FROM behalf_records WHERE kind = 'room' AND id = $1", [id])).rowCount === 1,
    };
  });
}

// ---- first boot, the lock ----
withHarness('first boot creates the table and the meta row in one go, and a second boot finds them', async (h) => {
  const s = await h.open();
  assert.equal(s.kind, 'postgres');
  const rows = (await q('SELECT kind, id, doc FROM behalf_records')).rows;
  assert.deepEqual(rows.map((r) => [r.kind, r.id]), [['meta', 'schema']]);
  assert.deepEqual(Object.keys(JSON.parse(rows[0].doc)).sort(), ['epoch', 'version']);
  assert.equal(JSON.parse(rows[0].doc).version, 1);
  await s.close();
  await h.open();
  assert.equal((await q('SELECT count(*) FROM behalf_records')).rows[0].count, '1');
  assert.equal(h.log.events().filter((e) => e === 'store.loaded').length, 2, 'one boot line per load');
  assert.ok(h.log.lines.filter((l) => l.event === 'store.loaded').every((l) => typeof l.fields.durationMs === 'number'));
});

withHarness('a second store cannot load while the first holds the lock: ELOCKED after the wait, with nothing written, then it can once the first closes', async (h) => {
  const first = await h.open();
  first.state.rooms.set('room0001', minimalRoom('room0001'));
  first.save('room0001');
  assert.equal(await first.settle(), true);
  const t0 = Date.now();
  const second = createPgStore({ url: URL_, log: h.log, lockWaitMs: 400, lockRetryMs: 50 });
  await assert.rejects(second.load(), (e) => e instanceof StoreError && e.code === 'ELOCKED');
  assert.ok(Date.now() - t0 >= 350, 'it retried for the wait');
  assert.equal(h.log.has('store.takeover'), false, 'the holder wins: there is no takeover');
  assert.equal(await second.persist('room', 'x'), false, 'a failed load leaves the store closed');
  const epochOf = async () => JSON.parse((await q("SELECT doc FROM behalf_records WHERE kind = 'meta'")).rows[0].doc).epoch;
  const mine = await epochOf();
  first.state.rooms.get('room0001').note = 'still writing';
  first.save('room0001');
  assert.equal(await first.settle(), true, 'the holder is not disturbed');
  assert.equal(await epochOf(), mine, 'the refused boot did not touch the epoch');
  await first.close();
  const third = await h.open();
  assert.equal(third.state.rooms.get('room0001').note, 'still writing');
});

// A TCP proxy in front of the database, to watch what one store sends and to hold its statements back. A held statement is
// the nearest thing to a peer that has gone silent.
async function makeProxy() {
  const target = new URL(URL_);
  const st = { seen: [], stalled: false, pattern: null, held: [], refuse: 0, conns: new Set() };
  const server = net.createServer((c) => {
    if (st.refuse > 0) { st.refuse--; c.destroy(); return; }
    const up = net.connect(Number(target.port || 5432), target.hostname);
    st.conns.add(c); st.conns.add(up);
    const end = () => { c.destroy(); up.destroy(); };
    c.on('data', (d) => {
      const text = d.toString('latin1');
      st.seen.push(text);
      if (st.stalled) { st.held.push([up, d]); return; }
      up.write(d);
      if (st.pattern && st.pattern.test(text)) { st.stalled = true; st.pattern = null; }
    });
    up.on('data', (d) => c.write(d));
    for (const x of [c, up]) { x.on('error', end); x.on('close', end); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const u = new URL(URL_);
  u.hostname = '127.0.0.1';
  u.port = String(server.address().port);
  return {
    url: u.toString(),
    seen: () => st.seen.join(''),
    stallAfter: (re) => { st.pattern = re; }, // forward the next chunk that matches, then hold everything after it
    isStalled: () => st.stalled,
    refuseNext: (n) => { st.refuse = n; },
    release: () => { st.stalled = false; for (const [up, d] of st.held.splice(0)) up.write(d); },
    close: () => new Promise((resolve) => { for (const x of st.conns) x.destroy(); server.close(resolve); }),
  };
}

withImport('every write path is fenced: a claim by another session between this store\'s claim and its import refuses the import, and nothing stale lands', async (h, { file, names }) => {
  await (await h.open()).close(); // the table, with only the meta row
  fs.writeFileSync(file, JSON.stringify(legacyDoc()));
  const proxy = await makeProxy();
  try {
    proxy.stallAfter(/SELECT kind, id, doc FROM behalf_records/); // the read right after the claim
    const store = createPgStore({ url: proxy.url, log: h.log, importFile: file });
    const loading = store.load();
    loading.catch(() => {});
    await waitFor(() => proxy.isStalled(), (v) => v === true, { intervalMs: 5, what: 'the store to finish its claim' });
    await q("UPDATE behalf_records SET doc = $1 WHERE kind = 'meta'", [JSON.stringify({ version: 1, epoch: 'a-later-claim' })]);
    proxy.release();
    await assert.rejects(loading, (e) => e instanceof StoreError && e.code === 'EEPOCH');
    assert.equal(await roomCount(), 0);
    assert.equal(JSON.parse((await q("SELECT doc FROM behalf_records WHERE kind = 'meta'")).rows[0].doc).epoch, 'a-later-claim');
    assert.deepEqual(names(), ['rooms.json'], 'the file was not renamed');
  } finally { await proxy.close(); }
});

withHarness('every write path is fenced: a claim by another session between this store\'s claim and its migration rewrite refuses the rewrite', async (h) => {
  await (await h.open()).close();
  const old = minimalRoom('old00001');
  delete old.seats.A.mode;
  await h.insert('room', 'old00001', old);
  await h.insert('meta', 'schema', { version: 0 });
  const proxy = await makeProxy();
  try {
    proxy.stallAfter(/SELECT kind, id, doc FROM behalf_records/);
    const store = createPgStore({ url: proxy.url, log: h.log });
    const loading = store.load();
    loading.catch(() => {});
    await waitFor(() => proxy.isStalled(), (v) => v === true, { intervalMs: 5, what: 'the store to finish its claim' });
    await q("UPDATE behalf_records SET doc = $1 WHERE kind = 'meta'", [JSON.stringify({ version: 0, epoch: 'a-later-claim' })]);
    proxy.release();
    await assert.rejects(loading, (e) => e instanceof StoreError && e.code === 'EEPOCH');
    assert.equal(JSON.parse((await q("SELECT doc FROM behalf_records WHERE id = 'old00001'")).rows[0].doc).seats.A.mode, undefined, 'the row was not rewritten');
    assert.equal(JSON.parse((await q("SELECT doc FROM behalf_records WHERE kind = 'meta'")).rows[0].doc).version, 0);
  } finally { await proxy.close(); }
});

withHarness('a zombie holder is reaped by the server: the session sets idle_in_transaction_session_timeout and the TCP keepalives, and a new boot gets through once the idle transaction is killed', async (h) => {
  const proxy = await makeProxy();
  try {
    const fatals = [];
    const zombie = await h.open({ url: proxy.url, idleTxMs: 800, onFatal: (e) => fatals.push(e) });
    const sent = proxy.seen();
    assert.match(sent, /SET idle_in_transaction_session_timeout = 800/);
    assert.match(sent, /SET tcp_keepalives_idle = 10/);
    assert.match(sent, /SET tcp_keepalives_interval = 5/);
    assert.match(sent, /SET tcp_keepalives_count = 3/);
    proxy.stallAfter(/FOR UPDATE/); // the zombie's next write takes the meta row lock and then goes silent
    zombie.state.rooms.set('room0001', minimalRoom('room0001'));
    zombie.save('room0001');
    await waitFor(() => proxy.isStalled(), (v) => v === true, { intervalMs: 5, what: 'the zombie to go silent in its transaction' });
    const t0 = Date.now();
    const next = await h.open({ lockWaitMs: 20000, lockRetryMs: 100, lockTimeoutMs: 300 });
    assert.ok(Date.now() - t0 >= 500, 'it had to wait for the idle transaction to be killed');
    assert.ok(Date.now() - t0 < 10000);
    assert.equal(next.health().ok, true);
    await waitFor(() => fatals.length, (n) => n === 1, { intervalMs: 20, what: 'the zombie to learn its session is gone' });
    assert.equal(await roomCount(), 0, 'the zombie never committed');
  } finally { await proxy.close(); }
});

withHarness('a row lock held on the meta row fails the claim fast (lock_timeout, PG_55P03) and the boot retries until it is free', async (h) => {
  await (await h.open()).close();
  await withBlocker(async (blocker) => {
    await blocker.query('BEGIN');
    await blocker.query("SELECT doc FROM behalf_records WHERE kind = 'meta' FOR UPDATE");
    const t0 = Date.now();
    await assert.rejects(createPgStore({ url: URL_, log: h.log, lockTimeoutMs: 300, connectBudgetMs: 0 }).load(), (e) => e.code === 'PG_55P03');
    assert.ok(Date.now() - t0 < 4000, 'it failed on its own lock_timeout');
    setTimeout(() => blocker.query('ROLLBACK').catch(() => {}), 1200);
    const t1 = Date.now();
    const s = await h.open({ lockTimeoutMs: 300 });
    assert.ok(Date.now() - t1 >= 900, 'it retried while the row was held');
    assert.equal(s.health().ok, true);
  });
});

withHarness('a big write is not fatal while it makes progress: many statements, each well inside the limit, together longer than the watchdog', async (h) => {
  const fatals = [];
  const s = await h.open({ statementTimeoutMs: 400, watchdogSlackMs: 200, onFatal: (e) => fatals.push(e) });
  await q('CREATE OR REPLACE FUNCTION behalf_slow_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NULL; END $$');
  await q('CREATE TRIGGER behalf_slow BEFORE INSERT ON behalf_records FOR EACH STATEMENT EXECUTE FUNCTION behalf_slow_test()');
  try {
    for (let i = 0; i < 500; i++) { const id = 'room' + String(i).padStart(5, '0'); s.state.rooms.set(id, minimalRoom(id)); }
    s.save();
    const t0 = Date.now();
    assert.equal(await s.settle(), true);
    assert.ok(Date.now() - t0 > 600, 'longer than statement timeout + slack in total: ' + (Date.now() - t0));
    assert.equal(fatals.length, 0);
    assert.equal(s.health().ok, true);
    await q('DROP TRIGGER behalf_slow ON behalf_records');
    assert.equal(await roomCount(), 500, 'and every row landed');
  } finally { await q('DROP FUNCTION IF EXISTS behalf_slow_test() CASCADE'); }
});


// ---- losing the store is fatal ----
const LOCKS_SQL = "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND classid = $1::oid"
  + ' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND objid = hashtext(current_database())::oid';
const lockPids = async () => (await q(LOCKS_SQL, [LOCK_CLASS])).rows.map((r) => r.pid);
const roomCount = async () => Number((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room'")).rows[0].count);

withHarness('the store connection is terminated: store.lock_lost, onFatal once, closed for good, health not ok, nothing written', async (h) => {
  const fatals = [];
  const s = await h.open({ onFatal: (e) => fatals.push(e) });
  const pids = await lockPids();
  assert.equal(pids.length, 1, 'the one connection holds the lock');
  await q('SELECT pg_terminate_backend($1)', [pids[0]]);
  await waitFor(() => fatals.length, (n) => n === 1, { intervalMs: 5, what: 'onFatal' });
  await sleep(150);
  assert.equal(fatals.length, 1, 'once');
  assert.ok(fatals[0] instanceof StoreError);
  assert.equal(h.log.lines.filter((l) => l.event === 'store.lock_lost').length, 1);
  const hl = s.health();
  assert.equal(hl.ok, false);
  assert.equal(typeof hl.failingSince, 'number', 'failingSince is set with nothing to write, so the 60 s guard sees it');
  s.state.rooms.set('room0001', minimalRoom('room0001'));
  s.save('room0001');
  assert.equal(await s.settle(), false);
  assert.equal(await roomCount(), 0);
  await waitFor(() => lockPids(), (p) => p.length === 0, { intervalMs: 20, what: 'the lock to be given back' });
  await s.close(); // still safe
});

withHarness('the backend is terminated in the middle of a write transaction: onFatal once, no uncaught exception', async (h) => {
  const fatals = [];
  const s = await h.open({ onFatal: (e) => fatals.push(e) });
  await withBlocker(async (blocker) => {
    await blocker.query('BEGIN');
    await blocker.query("SELECT doc FROM behalf_records WHERE kind = 'meta' FOR UPDATE"); // the write's first statement waits on this
    s.state.rooms.set('room0001', minimalRoom('room0001'));
    s.save('room0001');
    const blocked = await waitFor(async () => (await q("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows, (rows) => rows.length >= 1, { intervalMs: 10, what: 'the write to wait on the row lock' });
    assert.deepEqual(blocked.map((r) => r.pid), await lockPids(), "the blocked backend is the store's");
    await q('SELECT pg_terminate_backend($1)', [blocked[0].pid]);
    await waitFor(() => fatals.length, (n) => n === 1, { intervalMs: 5, what: 'onFatal' });
    await sleep(150);
    assert.equal(fatals.length, 1);
    assert.equal(h.log.lines.filter((l) => l.event === 'store.lock_lost').length, 1);
    assert.equal(h.log.lines.filter((l) => l.event === 'store.write_failed').length, 0, 'lost, not a failed write');
    assert.equal(s.health().ok, false);
  });
  assert.equal(await roomCount(), 0);
});

withHarness('the epoch is changed by another session: the next write is fatal and writes nothing', async (h) => {
  const fatals = [];
  const s = await h.open({ onFatal: (e) => fatals.push(e) });
  await q("UPDATE behalf_records SET doc = $1 WHERE kind = 'meta'", [JSON.stringify({ version: 1, epoch: 'someone-else' })]);
  s.state.rooms.set('room0001', minimalRoom('room0001'));
  s.save('room0001');
  assert.equal(await s.settle(), false);
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].code, 'EEPOCH');
  assert.equal(h.log.lines.filter((l) => l.event === 'store.lock_lost').length, 1);
  assert.equal(await roomCount(), 0);
  assert.equal(s.health().ok, false);
  s.save('room0001');
  assert.equal(await s.settle(), false, 'closed for good');
  assert.equal(fatals.length, 1);
});

withHarness('every load takes a new epoch, and a normal write leaves it alone', async (h) => {
  const s = await h.open();
  const epoch = () => q("SELECT doc FROM behalf_records WHERE kind = 'meta'").then((r) => JSON.parse(r.rows[0].doc).epoch);
  const e1 = await epoch();
  assert.match(e1, /^[0-9a-f]{16}$/);
  s.state.rooms.set('room0001', minimalRoom('room0001'));
  s.save('room0001');
  assert.equal(await s.settle(), true);
  assert.equal(await epoch(), e1);
  await s.close();
  await h.open();
  assert.notEqual(await epoch(), e1);
});

// ---- the one-time import ----
const legacyRoom = (id, note) => Object.assign(minimalRoom(id), { note });
const legacyDoc = () => ({
  schemaVersion: 1, rooms: { room0001: legacyRoom('room0001', 'a'), room0002: legacyRoom('room0002', 'b') },
  usage: { day: 'd', total: 2, byIp: { x: 2 }, failedByIp: {} }, users: { 1: { id: '1' } },
});

function withImport(title, fn) {
  withHarness(title, async (h, t) => {
    const dir = mkTmp('pg-import-');
    t.after(() => rmTmp(dir));
    const file = path.join(dir, 'rooms.json');
    await fn(h, { dir, file, names: () => fs.readdirSync(dir).sort() });
  });
}

withImport('import: rooms.json goes into an empty table in one transaction, then is renamed, and a later boot does not import again', async (h, { dir, file, names }) => {
  const text = JSON.stringify(legacyDoc());
  fs.writeFileSync(file, text);
  const s = await h.open({ importFile: file });
  assert.deepEqual([...s.state.rooms.keys()].sort(), ['room0001', 'room0002']);
  assert.equal(s.state.rooms.get('room0001').note, 'a');
  assert.equal(s.state.usage.total, 2);
  assert.deepEqual([...s.collection('user').map.keys()], ['1']);
  const meta = JSON.parse((await q("SELECT doc FROM behalf_records WHERE kind = 'meta'")).rows[0].doc);
  assert.equal(meta.version, 1);
  assert.equal(meta.importedFrom, 'rooms.json');
  assert.match(meta.importedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room'")).rows[0].count, '2', 'written before the first save');
  const left = names();
  assert.equal(left.length, 1, left.join());
  assert.match(left[0], /^rooms\.json\.imported-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
  assert.equal(fs.readFileSync(path.join(dir, left[0]), 'utf8'), text, 'the file is kept as it was');
  // A file that appears later is not imported: the table has rows and the import marker is set.
  await s.close();
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, rooms: { other001: legacyRoom('other001', 'z') } }));
  const again = await h.open({ importFile: file });
  assert.deepEqual([...again.state.rooms.keys()].sort(), ['room0001', 'room0002']);
  assert.equal(fs.existsSync(file), true, 'a different file left behind is not the imported one: left alone, and not imported');
});

withImport('import is read-only: a partly bad file is imported without its bad room and leaves no quarantine, partial or temp file', async (h, { file, names }) => {
  const doc = legacyDoc();
  delete doc.rooms.room0002.claims;
  fs.writeFileSync(file, JSON.stringify(doc));
  const s = await h.open({ importFile: file });
  assert.deepEqual([...s.state.rooms.keys()], ['room0001']);
  assert.equal(names().length, 1);
  assert.match(names()[0], /^rooms\.json\.imported-/);
  assert.ok(h.log.has('store.room_skipped'));
});

withImport('import: no file, or a file of no rooms, starts normally; the marker stops a second import, and a file left behind is renamed at the next boot', async (h, { file, names }) => {
  const s = await h.open({ importFile: file });
  assert.equal(s.state.rooms.size, 0);
  await s.close();
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, rooms: {} }));
  const s2 = await h.open({ importFile: file });
  assert.equal(s2.state.rooms.size, 0);
  assert.ok(JSON.parse((await q("SELECT doc FROM behalf_records WHERE kind = 'meta'")).rows[0].doc).importedAt, 'imported, though it held nothing');
  assert.equal(names().filter((n) => n.startsWith('rooms.json.imported-')).length, 1);
  await s2.close();
  // A different file turning up later is not the imported one: it is left alone, and not imported.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, rooms: { room0009: legacyRoom('room0009', 'x') } }));
  const s3 = await h.open({ importFile: file });
  assert.equal(s3.state.rooms.size, 0, 'the import marker stops a second import into a still empty table');
  assert.equal(fs.existsSync(file), true, 'left alone: its hash is not the recorded one');
  assert.equal(names().filter((n) => n.startsWith('rooms.json.imported-')).length, 1);
});

for (const [name, content] of [['a file that is not JSON', '{"rooms": SECRET-ROOM-TEXT not json'], ['an empty file', ''], ['a file of the wrong shape', '[]']]) {
  withImport('import: ' + name + ' is set aside as rooms.json.corrupt-<time> and the store starts empty', async (h, { dir, file, names }) => {
    fs.writeFileSync(file, content);
    const s = await h.open({ importFile: file });
    assert.equal(s.state.rooms.size, 0);
    const left = names();
    assert.equal(left.length, 1, left.join());
    assert.match(left[0], /^rooms\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
    assert.equal(fs.readFileSync(path.join(dir, left[0]), 'utf8'), content, 'kept as it was');
    assert.ok(h.log.has('store.import_quarantined'));
    assert.ok(!JSON.stringify(h.log.lines.map((l) => [l.event, l.fields])).includes('SECRET-ROOM-TEXT'));
    assert.equal(await roomCount(), 0);
  });
}

withImport('import: a table that already has rows is not imported into: store.import_skipped (warn), the file stays, the rows are untouched', async (h, { file, names }) => {
  await (await h.open()).close();
  await h.insert('room', 'room0001', minimalRoom('room0001')); // data, and no import marker in meta
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, rooms: { other001: legacyRoom('other001', 'z') } }));
  const s = await h.open({ importFile: file });
  assert.deepEqual([...s.state.rooms.keys()], ['room0001']);
  assert.equal(fs.existsSync(file), true, 'not renamed');
  assert.deepEqual(names(), ['rooms.json']);
  const skipped = h.log.lines.filter((l) => l.event === 'store.import_skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].level, 'warn');
  assert.equal(h.log.has('store.import_rename_finished'), false, 'a file that was left alone is not reported as renamed');
  assert.equal(h.log.has('store.imported'), false);
  assert.equal(await roomCount(), 1);
});

withImport('import: a successful import logs one store.imported info line with a duration', async (h, { file }) => {
  fs.writeFileSync(file, JSON.stringify(legacyDoc()));
  await h.open({ importFile: file });
  const lines = h.log.lines.filter((l) => l.event === 'store.imported');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'info');
  assert.equal(typeof lines[0].fields.durationMs, 'number');
});

withImport('import is atomic: a failure on the second batch leaves no room, no import marker and the file in place', async (h, { file, names }) => {
  await (await h.open()).close(); // the table, with only the meta row
  await q("ALTER TABLE behalf_records ADD CONSTRAINT nope CHECK (id <> 'room0150') NOT VALID");
  const rooms = {};
  for (let i = 0; i < 200; i++) { const id = 'room' + String(i).padStart(4, '0'); rooms[id] = minimalRoom(id); }
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, rooms }));
  const s = createPgStore({ url: URL_, log: h.log, importFile: file });
  await assert.rejects(s.load(), (e) => e instanceof StoreError && e.code === 'PG_23514');
  assert.equal(await roomCount(), 0, 'the first batch was rolled back with the rest');
  assert.equal(JSON.parse((await q("SELECT doc FROM behalf_records WHERE kind = 'meta'")).rows[0].doc).importedAt, undefined);
  assert.deepEqual(names(), ['rooms.json']);
  await waitFor(() => lockPids(), (p) => p.length === 0, { intervalMs: 20, what: 'the lock to be given back' });
  await q('ALTER TABLE behalf_records DROP CONSTRAINT nope');
  const again = await h.open({ importFile: file }); // and the same file imports once the cause is gone
  assert.equal(again.state.rooms.size, 200);
});

const EIMPORT_CASES = [
  ['an unreadable file', (file) => fs.mkdirSync(file)],
  ['a file from a newer version', (file) => fs.writeFileSync(file, '{"schemaVersion":99,"rooms":{},"usage":{}}')],
  ['a file whose every room is unusable', (file) => fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, rooms: { bad00001: { id: 'bad00001' } } }))],
];
for (const [name, prepare] of EIMPORT_CASES) {
  withImport(`import: ${name} refuses the boot with EIMPORT, leaves the file where it is and writes no room`, async (h, { dir, file, names }) => {
    prepare(file);
    const before = names();
    const stat = fs.statSync(file);
    const bytes = stat.isFile() ? fs.readFileSync(file) : null;
    const s = createPgStore({ url: URL_, log: h.log, importFile: file });
    await assert.rejects(s.load(), (e) => e instanceof StoreError && e.code === 'EIMPORT');
    assert.deepEqual(names(), before, 'nothing renamed, quarantined or copied');
    if (bytes) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind <> 'meta'")).rows[0].count, '0');
    assert.ok(!JSON.stringify(h.log.lines.map((l) => [l.event, l.fields])).includes('SECRET-ROOM-TEXT'));
    await waitFor(() => lockPids(), (p) => p.length === 0, { intervalMs: 20, what: 'the failed load to give its lock back' });
  });
}

// ---- skipped rows ----
withHarness('a stored row that cannot be loaded is skipped, kept in the table through every write, and never deleted', async (h) => {
  const bad = { id: 'bad00001' }; // no seats: not a room
  await (async () => {
    const s = await h.open();
    await s.close();
  })();
  await h.insert('room', 'good0001', minimalRoom('good0001'));
  await h.insert('room', 'bad00001', bad);
  await h.insert('room', 'junk0001', 'not json at all');
  await h.insert('user', 'u-array', '[1,2]');
  await h.insert('user', 'u-ok', { id: 'ok' });
  const s = await h.open();
  assert.deepEqual([...s.state.rooms.keys()], ['good0001']);
  for (const id of ['bad00001', 'junk0001']) assert.equal(s.isSkipped('room', id), true, id);
  assert.equal(s.isSkipped('user', 'u-array'), true);
  assert.deepEqual([...s.collection('user').map.keys()], ['u-ok']);
  assert.equal(h.log.lines.filter((l) => l.event === 'store.room_skipped').length, 2);
  assert.equal(h.log.lines.filter((l) => l.event === 'store.record_skipped').length, 1);
  assert.ok(!JSON.stringify(h.log.lines.filter((l) => l.event === 'store.record_skipped').map((l) => l.fields)).includes('u-array'), 'an account row is logged without its id');
  s.save(); // everything dirty
  s.save('bad00001'); // a delete of a skipped id
  s.collection('user').save('u-array');
  s.state.rooms.set('room0003', minimalRoom('room0003'));
  s.save('room0003');
  assert.equal(await s.settle(), true);
  const rows = Object.fromEntries((await q("SELECT kind || '/' || id AS k, doc FROM behalf_records WHERE kind IN ('room', 'user')")).rows.map((r) => [r.k, r.doc]));
  assert.equal(rows['room/bad00001'], JSON.stringify(bad));
  assert.equal(rows['room/junk0001'], 'not json at all');
  assert.equal(rows['user/u-array'], '[1,2]');
  assert.ok(rows['room/room0003'] && rows['room/good0001']);
});

withHarness('every stored room unusable is not fatal on Postgres: it loads empty, keeps the rows, and a new room does not disturb them', async (h) => {
  await (await h.open()).close();
  await h.insert('room', 'bad00001', { id: 'bad00001' });
  const s = await h.open();
  assert.equal(s.state.rooms.size, 0);
  assert.equal(s.isSkipped('room', 'bad00001'), true);
  s.state.rooms.set('room0002', minimalRoom('room0002'));
  s.save();
  s.save('bad00001');
  assert.equal(await s.settle(), true);
  assert.equal((await q("SELECT doc FROM behalf_records WHERE id = 'bad00001'")).rows[0].doc, JSON.stringify({ id: 'bad00001' }));
  assert.equal(await roomCount(), 2);
});

withHarness('a migration with a skipped room rewrites the good rooms but does not bump the meta version', async (h) => {
  await (await h.open()).close();
  const old = minimalRoom('old00001');
  delete old.seats.A.mode;
  await h.insert('room', 'old00001', old);
  await h.insert('room', 'bad00001', { id: 'bad00001' });
  await h.insert('meta', 'schema', { version: 0 });
  const s = await h.open();
  assert.equal(s.state.rooms.get('old00001').seats.A.mode, 'builtin');
  assert.equal(JSON.parse((await q("SELECT doc FROM behalf_records WHERE id = 'old00001'")).rows[0].doc).seats.A.mode, 'builtin');
  assert.equal(JSON.parse((await q("SELECT doc FROM behalf_records WHERE kind = 'meta'")).rows[0].doc).version, 0, 'migrated again at the next boot');
  await s.close();
  await h.open(); // and that boot works
});

withHarness('a meta version newer than the code refuses the load with EFUTURESCHEMA and an unusable meta row with ESHAPE', async (h) => {
  await (await h.open()).close();
  await h.insert('meta', 'schema', { version: 99 });
  await assert.rejects(createPgStore({ url: URL_, log: h.log }).load(), (e) => e.code === 'EFUTURESCHEMA');
  await h.insert('meta', 'schema', 'garbage');
  await assert.rejects(createPgStore({ url: URL_, log: h.log }).load(), (e) => e.code === 'ESHAPE');
  await h.insert('meta', 'schema', { version: 'one' });
  await assert.rejects(createPgStore({ url: URL_, log: h.log }).load(), (e) => e.code === 'ESHAPE');
});

withHarness('a room id that is a prototype key stays an ordinary room', async (h) => {
  const s = await h.open();
  s.state.rooms.set('__proto__', minimalRoom('__proto__'));
  s.save('__proto__');
  assert.equal(await s.settle(), true);
  await s.close();
  const again = await h.open();
  assert.ok(again.state.rooms.has('__proto__'));
  assert.equal(Object.getPrototypeOf(again.state.rooms.get('__proto__')), Object.prototype);
});

// ---- content ----
withHarness('a room holding a NUL and a lone surrogate is stored as ASCII text, so the database can never refuse it', async (h) => {
  const s = await h.open();
  const r = minimalRoom('weird001');
  r.topic = 'a\u0000b\ud83d';
  s.state.rooms.set('weird001', r);
  s.save('weird001');
  assert.equal(await s.settle(), true);
  const doc = (await q("SELECT doc FROM behalf_records WHERE id = 'weird001'")).rows[0].doc;
  assert.ok(doc.includes('\\u0000') && doc.includes('\\ud83d'));
  assert.ok(!doc.includes('\u0000'));
});

withHarness('a big first write (all rooms dirty) goes out in batches inside the time limit', async (h) => {
  const s = await h.open();
  for (let i = 0; i < 450; i++) { const id = 'room' + String(i).padStart(4, '0'); s.state.rooms.set(id, minimalRoom(id)); }
  s.save();
  assert.equal(await s.settle(), true);
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room'")).rows[0].count, '450');
  for (let i = 0; i < 450; i += 2) s.state.rooms.delete('room' + String(i).padStart(4, '0'));
  s.save();
  assert.equal(await s.settle(), true);
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room'")).rows[0].count, '225');
});

withHarness('updated_at moves on an update', async (h) => {
  const s = await h.open();
  s.state.rooms.set('room0001', minimalRoom('room0001'));
  s.save('room0001');
  await s.settle();
  const first = (await q("SELECT updated_at FROM behalf_records WHERE id = 'room0001'")).rows[0].updated_at;
  await sleep(20);
  s.state.rooms.get('room0001').note = 'n';
  s.save('room0001');
  await s.settle();
  const second = (await q("SELECT updated_at FROM behalf_records WHERE id = 'room0001'")).rows[0].updated_at;
  assert.ok(second > first);
});

// ---- failing and slow writes ----
withHarness('a write the database refuses is retried with backoff, health shows failingSince, the log carries PG_<SQLSTATE> and no content, and it recovers', async (h) => {
  const lines = [];
  const log = createLog({ stream: { write: (l) => lines.push(l) } });
  const s = await h.open({ log, debounceMs: 20 });
  await q("ALTER TABLE behalf_records ADD CONSTRAINT nope CHECK (id <> 'room0001') NOT VALID");
  const r = minimalRoom('room0001');
  r.note = 'SECRET-NOTE-TEXT';
  s.state.rooms.set('room0001', r);
  s.state.rooms.set('room0002', minimalRoom('room0002'));
  s.save('room0001');
  s.save('room0002');
  const bad = await waitFor(() => s.health(), (v) => v.ok === false, { intervalMs: 5, what: 'the failed write' });
  assert.equal(typeof bad.failingSince, 'number');
  await sleep(300);
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room'")).rows[0].count, '0', 'the whole transaction rolled back, room0002 too');
  const fails = lines.filter((l) => l.includes('event="store.write_failed"'));
  assert.ok(fails.length >= 1 && fails.length <= 3, 'logged on the first failure, then at most once per backoff cap (P4): ' + fails.length);
  assert.match(fails[0], /errorClass="StoreError" code="PG_23514"/);
  assert.ok(!lines.join('').includes('SECRET-NOTE-TEXT') && !lines.join('').includes('room0001'));
  assert.equal(s.health().failingSince, bad.failingSince, 'failingSince stays put through the retries');
  await q('ALTER TABLE behalf_records DROP CONSTRAINT nope');
  await waitFor(() => s.health(), (v) => v.ok === true, { timeoutMs: 8000, what: 'the retry to succeed' });
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room'")).rows[0].count, '2');
});

withHarness('a write that fails midway changes nothing: the rows already there are as they were', async (h) => {
  const s = await h.open({ debounceMs: 20 });
  const r1 = minimalRoom('room0001');
  r1.note = 'before';
  s.state.rooms.set('room0001', r1);
  s.save('room0001');
  assert.equal(await s.settle(), true);
  await q("ALTER TABLE behalf_records ADD CONSTRAINT nope CHECK (id <> 'room0002') NOT VALID");
  r1.note = 'after';
  s.state.rooms.set('room0002', minimalRoom('room0002'));
  s.save('room0001');
  s.save('room0002');
  s.state.usage.total = 7;
  s.saveUsage();
  assert.equal(await s.settle(), false);
  assert.equal(JSON.parse((await q("SELECT doc FROM behalf_records WHERE id = 'room0001'")).rows[0].doc).note, 'before');
  assert.equal(await roomCount(), 1);
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'usage' AND doc LIKE '%\"total\":7%'")).rows[0].count, '0');
  await q('ALTER TABLE behalf_records DROP CONSTRAINT nope');
  assert.equal(await s.settle(), true, 'and the retry carries all of it');
  assert.equal(JSON.parse((await q("SELECT doc FROM behalf_records WHERE id = 'room0001'")).rows[0].doc).note, 'after');
  assert.equal(await roomCount(), 2);
});

withHarness('a statement the server cuts off (statement_timeout) fails that write only: PG_57014, retried with backoff, not fatal', async (h) => {
  const fatals = [];
  const s = await h.open({ statementTimeoutMs: 200, debounceMs: 20, onFatal: (e) => fatals.push(e) });
  await withBlocker(async (blocker) => {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE behalf_records IN ACCESS EXCLUSIVE MODE');
    s.state.rooms.set('room0001', minimalRoom('room0001'));
    s.save('room0001');
    await waitFor(() => s.health(), (v) => v.ok === false, { intervalMs: 10, what: 'the cut-off write' });
    assert.equal(h.log.lines.find((l) => l.event === 'store.write_failed').err.code, 'PG_57014');
    await blocker.query('ROLLBACK');
    await waitFor(() => s.health(), (v) => v.ok === true, { timeoutMs: 8000, what: 'recovery' });
    assert.equal(await roomCount(), 1);
    assert.equal(fatals.length, 0);
  });
});

withHarness('a statement that gets no answer at all within its watchdog destroys the connection: fatal (store.connection_lost, ETIMEDOUT), and nothing commits late', async (h) => {
  const proxy = await makeProxy();
  try {
    const fatals = [];
    const s = await h.open({ url: proxy.url, statementTimeoutMs: 200, watchdogSlackMs: 300, debounceMs: 20, onFatal: (e) => fatals.push(e) });
    proxy.stallAfter(/FOR UPDATE/); // the write's fence statement goes out, and the next one is never answered
    s.state.rooms.set('room0001', minimalRoom('room0001'));
    s.save('room0001');
    await waitFor(() => fatals.length, (n) => n === 1, { intervalMs: 10, what: 'the watchdog' });
    assert.equal(fatals[0].code, 'ETIMEDOUT');
    assert.equal(h.log.lines.filter((l) => l.event === 'store.connection_lost').length, 1);
    assert.equal(h.log.lines.filter((l) => l.event === 'store.lock_lost').length, 0, 'the watchdog is the reason, logged once');
    proxy.release();
    await sleep(300);
    assert.equal(await roomCount(), 0, 'the destroyed transaction did not commit');
    assert.equal(s.health().ok, false);
    await waitFor(() => lockPids(), (p) => p.length === 0, { intervalMs: 20, what: 'the backend to go' });
  } finally { await proxy.close(); }
});

withHarness('drain with a write in flight waits for it, then ends the pool and the lock client; the data is durable', async (h) => {
  const s = await h.open({ debounceMs: 20 });
  await withBlocker(async (blocker) => {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE behalf_records IN ACCESS EXCLUSIVE MODE');
    s.state.rooms.set('room0001', minimalRoom('room0001'));
    s.save('room0001');
    await waitFor(async () => (await q("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].count, (n) => Number(n) >= 1, { intervalMs: 10, what: 'the write to be blocked in the database' });
    let done = false;
    const p = s.drain().then((ok) => { done = true; return ok; });
    await sleep(150);
    assert.equal(done, false, 'drain waits for the write in flight');
    await blocker.query('ROLLBACK');
    assert.equal(await p, true);
  });
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room'")).rows[0].count, '1');
  await waitFor(() => lockPids(), (p) => p.length === 0, { intervalMs: 20, what: 'the lock to be given back' });
  const conns = await q("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name = ''");
  assert.equal(conns.rows[0].count, '0', 'no connection of the store is left');
  assert.equal(await s.drain(), false, 'a second drain is terminal: it has nothing left to write');
});

withHarness('close() waits for the write in flight and never rejects, twice over', async (h) => {
  const s = await h.open({ debounceMs: 20 });
  s.state.rooms.set('room0001', minimalRoom('room0001'));
  s.save('room0001');
  await sleep(40);
  await s.close();
  await s.close();
  assert.equal(await s.persist('room', 'room0001'), false);
});

// ---- migration ----
withHarness('a v0 store is migrated on load, and its rooms and meta are rewritten before load returns', async (h) => {
  await (await h.open()).close();
  const old = minimalRoom('old00001');
  delete old.seats.A.mode;
  old.demo = 'yes';
  await h.insert('room', 'old00001', old);
  await h.insert('meta', 'schema', { version: 0 });
  const s = await h.open();
  assert.equal(s.state.rooms.get('old00001').seats.A.mode, 'builtin');
  const row = JSON.parse((await q("SELECT doc FROM behalf_records WHERE id = 'old00001'")).rows[0].doc);
  assert.equal(row.seats.A.mode, 'builtin', 'rewritten before any save');
  assert.equal(row.demo, false);
  assert.equal(JSON.parse((await q("SELECT doc FROM behalf_records WHERE kind = 'meta'")).rows[0].doc).version, 1);
});

// ---- the connection ----

test('an unencrypted, non-local url logs store.no_tls once, as a warning, and does not refuse', { ...T, skip: !hasPg }, async () => {
  const log = capture();
  await assert.rejects(createPgStore({ url: 'postgres://u:SECRET-PW@no-such-host.invalid:5432/x', log, connectBudgetMs: 0 }).load());
  assert.equal(log.lines.filter((l) => l.event === 'store.no_tls').length, 1);
  assert.equal(log.lines.find((l) => l.event === 'store.no_tls').level, 'warn');
});

test('a database that cannot be reached is retried with backoff for the connect budget, then fails with the Node code; the password never reaches the log', { ...T, skip: !hasPg }, async () => {
  const log = capture();
  const t0 = Date.now();
  const s = createPgStore({ url: 'postgres://user:SECRET-DB-PASSWORD@127.0.0.1:1/behalf', log, connectBudgetMs: 1500 });
  await assert.rejects(s.load(), (e) => e instanceof StoreError && e.code === 'ECONNREFUSED');
  const took = Date.now() - t0;
  assert.ok(took >= 1400 && took < 4000, 'retried (500, 1000 ms) until the budget was used: ' + took);
  assert.ok(!JSON.stringify(log.lines.map((l) => [l.event, l.fields, l.err && l.err.code])).includes('SECRET-DB-PASSWORD'));
});

test('a budget of 0 fails at the first refused connection', { ...T, skip: !hasPg }, async () => {
  const t0 = Date.now();
  await assert.rejects(createPgStore({ url: 'postgres://u:p@127.0.0.1:1/x', log: capture(), connectBudgetMs: 0 }).load(), (e) => e.code === 'ECONNREFUSED');
  assert.ok(Date.now() - t0 < 1000);
});

test('a wrong password fails at once, whatever the budget, with the SQLSTATE code and no secret', DB, async () => {
  const log = capture();
  const bad = URL_.replace(/\/\/([^:]+):[^@]*@/, '//$1:SECRET-WRONG-PW@');
  assert.notEqual(bad, URL_);
  const t0 = Date.now();
  await assert.rejects(createPgStore({ url: bad, log, connectBudgetMs: 30000 }).load(), (e) => e instanceof StoreError && /^PG_28/.test(e.code));
  assert.ok(Date.now() - t0 < 3000, 'not retried');
  assert.ok(!JSON.stringify(log.lines.map((l) => [l.event, l.fields, l.err && l.err.code])).includes('SECRET-WRONG-PW'));
});

test('an unparsable url fails the load with a StoreError whose message is fixed', { ...T, skip: !hasPg }, async () => {
  const s = createPgStore({ url: 'postgres://user:SECRET-DB-PASSWORD@@:::/x', log: capture() });
  await assert.rejects(s.load(), (e) => e instanceof StoreError && !e.message.includes('SECRET-DB-PASSWORD'));
});

withImport('import: the imported file\'s hash is recorded, and a file left behind is renamed at the next boot only when it is that same file', async (h, { dir, file, names }) => {
  const text = JSON.stringify(legacyDoc());
  fs.writeFileSync(file, text);
  const s = await h.open({ importFile: file });
  const meta = JSON.parse((await q("SELECT doc FROM behalf_records WHERE kind = 'meta'")).rows[0].doc);
  assert.equal(meta.importedSha256, require('crypto').createHash('sha256').update(text).digest('hex'));
  await s.close();
  const imported = names().filter((n) => n.startsWith('rooms.json.imported-'));
  assert.equal(imported.length, 1);
  // a crash between the commit and the rename: the same bytes are back at rooms.json
  fs.copyFileSync(path.join(dir, imported[0]), file);
  const s2 = await h.open({ importFile: file });
  assert.equal(fs.existsSync(file), false, 'the same file is renamed');
  assert.equal(h.log.has('store.import_skipped'), false);
  const finished = h.log.lines.filter((l) => l.event === 'store.import_rename_finished');
  assert.equal(finished.length, 1, 'the leftover rename is logged once');
  assert.equal(finished[0].level, 'info');
  await s2.close();
  // a different file is not ours to rename
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, rooms: { other001: legacyRoom('other001', 'z') } }));
  const before = names();
  const s3 = await h.open({ importFile: file });
  assert.equal(fs.existsSync(file), true, 'left alone');
  assert.deepEqual(names(), before);
  const skipped = h.log.lines.filter((l) => l.event === 'store.import_skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].level, 'warn');
  assert.equal(h.log.lines.filter((l) => l.event === 'store.import_rename_finished').length, 1, 'still only the one real rename');
  assert.deepEqual([...s3.state.rooms.keys()].sort(), ['room0001', 'room0002'], 'and not imported');
});

withHarness('rows of a kind that is a prototype name are ignored, not read through the kind table', async (h) => {
  const s0 = await h.open();
  s0.state.rooms.set('room0001', minimalRoom('room0001'));
  s0.save('room0001');
  await s0.settle();
  await s0.close();
  for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) await h.insert(kind, 'x', { id: 'x' });
  const s = await h.open();
  assert.deepEqual([...s.state.rooms.keys()], ['room0001']);
  assert.equal(h.log.has('store.record_skipped'), false);
  s.save();
  assert.equal(await s.settle(), true);
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind IN ('constructor', '__proto__', 'toString', 'hasOwnProperty')")).rows[0].count, '4', 'and left in the table');
});

test('pgError and classify: a terminated connection is ECONNRESET, a server error is PG_<SQLSTATE>, and only connection-level failures are retried', () => {
  assert.equal(pgError(new Error('Connection terminated unexpectedly')).code, 'ECONNRESET');
  assert.equal(pgError(Object.assign(new Error('x'), { code: '57P01', severity: 'FATAL' })).code, 'PG_57P01');
  assert.equal(pgError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code, 'ECONNREFUSED');
  assert.equal(pgError(new Error('Client is not queryable')).code, 'ECONNRESET');
  assert.equal(pgError(new Error('Query read timeout')).code, 'ETIMEDOUT');
  assert.equal(pgError(new Error('something else')).code, 'EPG');
  for (const code of ['ECONNREFUSED', 'ENOENT', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'PG_57P03', 'PG_57P01', 'PG_57P02', 'PG_53300', 'PG_08006', 'PG_08001', 'PG_08P01', 'PG_55P03']) assert.deepEqual([classify(new StoreError(code, 'x')).kind, classify(new StoreError(code, 'x')).code], ['connection', code], code);
  for (const code of ['PG_28P01', 'PG_28000', 'PG_3D000', 'PG_42501', 'EFUTURESCHEMA', 'ELOCKED', 'EPOOLER', 'EEPOCH', 'EIMPORT', 'ETABLEOWNER', 'EACCES', 'EPG']) assert.notEqual(classify(new StoreError(code, 'x')).kind, 'connection', code);
});

// A loaded store on a stub whose write statement can be made to fail with an error of our choosing, without any events.
async function loadedStub(failWith) {
  const log = capture();
  const fatals = [];
  let metaDoc = null;
  const state = { failing: false };
  const stub = stubPg({ pids: [5, 6], holder: 5, onQuery: (c, sql, params) => {
    if (/^(BEGIN|COMMIT|ROLLBACK|SET )/.test(sql) || /set_config|CREATE TABLE/.test(sql)) return { rows: [] };
    if (/pg_class/.test(sql)) return { rows: [{ mine: true }] };
    if (/FOR UPDATE/.test(sql)) return { rows: [{ doc: metaDoc || JSON.stringify({ version: 1 }) }] };
    if (/^INSERT INTO behalf_records \(kind, id, doc\) VALUES/.test(sql)) return { rows: [] };
    if (/^UPDATE behalf_records/.test(sql)) { metaDoc = params[0]; return { rows: [] }; }
    if (/^SELECT kind, id, doc/.test(sql)) return { rows: [] };
    if (/unnest/.test(sql) && state.failing) throw failWith();
    if (/unnest/.test(sql)) return { rows: [] };
    return undefined;
  } });
  const store = createPgStore({ url: 'postgres://u:p@127.0.0.1/x', log, pgModule: stub.pgModule, debounceMs: 20, onFatal: (e) => fatals.push(e) });
  await store.load();
  return { store, log, fatals, state };
}

test('a connection-class rejection of a write loses the store at once: onFatal once, store.lock_lost, and no store.write_failed line first', async () => {
  const { store, log, fatals, state } = await loadedStub(() => new Error('Connection terminated unexpectedly'));
  state.failing = true;
  store.state.rooms.set('room0001', minimalRoom('room0001'));
  store.save('room0001');
  assert.equal(await store.settle(), false);
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].code, 'ECONNRESET');
  assert.equal(log.lines.filter((l) => l.event === 'store.lock_lost').length, 1);
  assert.equal(log.lines.filter((l) => l.event === 'store.write_failed').length, 0);
  assert.equal(store.health().ok, false);
  assert.equal(await store.persist('room', 'room0001'), false, 'closed for good');
  await store.close();
});

test('a statement-class rejection of a write is an ordinary failure: write_failed, backoff, no loss', async () => {
  const { store, log, fatals, state } = await loadedStub(() => Object.assign(new Error('x'), { code: '23514', severity: 'ERROR' }));
  state.failing = true;
  store.state.rooms.set('room0001', minimalRoom('room0001'));
  store.save('room0001');
  assert.equal(await store.settle(), false);
  assert.equal(fatals.length, 0);
  assert.equal(log.lines.filter((l) => l.event === 'store.write_failed').length, 1);
  assert.equal(log.lines.filter((l) => l.event === 'store.lock_lost').length, 0);
  state.failing = false;
  assert.equal(await store.settle(), true, 'and it recovers');
  await store.close();
});

test('the default watchdog slack is generous (at least 15 s) and the statement timeout 3 s, under the 4 s drain default: a slow answer is not a dead connection', () => {
  assert.ok(WATCHDOG_SLACK_MS >= 15000, String(WATCHDOG_SLACK_MS));
  assert.equal(STATEMENT_MS, 3000);
  assert.ok(STATEMENT_MS < loadConfig({}).drainDeadlineMs, 'one statement fits the default drain deadline');
});

test('rowsToDoc takes its top-level keys from the kind table: a new kind round-trips, a singleton and an unknown kind do not add a collection', () => {
  const { rowsToDoc } = require('../lib/store-pg');
  const enc = (v) => JSON.stringify(v);
  const kinds = {
    room: { key: 'rooms' }, usage: { key: 'usage', singleton: 'today' },
    widget: { key: 'widgets' }, user: { key: 'users' },
  };
  const rows = [
    { kind: 'room', id: 'r1', doc: enc({ id: 'r1' }) }, { kind: 'widget', id: 'w1', doc: enc({ a: 1 }) },
    { kind: 'widget', id: '__proto__', doc: enc({ b: 2 }) }, { kind: 'widget', id: 'bad', doc: '{not json' },
    { kind: 'usage', id: 'today', doc: enc({ day: 'd' }) }, { kind: 'meta', id: 'schema', doc: enc({ version: 1 }) },
    { kind: 'other', id: 'x', doc: '{}' },
  ];
  const { raw, texts } = rowsToDoc(rows, 1, { error() {} }, kinds);
  assert.deepEqual(Object.keys(raw).sort(), ['rooms', 'schemaVersion', 'usage', 'users', 'widgets']);
  assert.deepEqual(raw.widgets.w1, { a: 1 });
  assert.equal(Object.getPrototypeOf(raw.widgets), null);
  assert.deepEqual(raw.widgets.__proto__, { b: 2 });
  assert.equal(raw.widgets.bad, null, 'unusable text is a null the core skips');
  assert.deepEqual(raw.users, Object.create(null), 'a kind with no rows is an empty collection');
  assert.deepEqual(raw.usage, { day: 'd' });
  assert.equal(texts.widget.get('w1'), enc({ a: 1 }));
  assert.equal(Object.hasOwn(texts, 'other'), false);
  // And against the real table: every non-singleton kind of KIND has its collection.
  const real = rowsToDoc([], 1, { error() {} });
  assert.deepEqual(Object.keys(real.raw).sort(), ['agentkeys', 'rooms', 'schemaVersion', 'sessions', 'users']);
});

// A fake clock: sleeping moves time on and is recorded, so the boot's retry and lock loops run without waiting.
function fakeTime() {
  const c = { t: 1000, sleeps: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
}

test('the boot retry runs on the injected clock: refused connections back off 500, 1000 ms and then what is left of the budget, with no real waiting', async () => {
  const clock = fakeTime();
  const FakeClient = class {
    on() {}
    async connect() { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }
  };
  const t0 = Date.now();
  await assert.rejects(createPgStore({ url: 'postgres://u:p@127.0.0.1/x', log: capture(), clock, connectBudgetMs: 2000, pgModule: { Client: FakeClient } }).load(), (e) => e.code === 'ECONNREFUSED');
  assert.deepEqual(clock.sleeps, [500, 1000, 500]);
  assert.ok(Date.now() - t0 < 1000);
});

test('the lock loop runs on the injected clock: ELOCKED after lockWaitMs of lockRetryMs sleeps, with no real waiting', async () => {
  const clock = fakeTime();
  const stub = stubPg({ pids: [1], holder: 2, onQuery: (c, sql) => (/pg_try_advisory_lock/.test(sql) ? { rows: [{ got: false, pid: 1 }] } : undefined) });
  const t0 = Date.now();
  await assert.rejects(createPgStore({ url: 'postgres://u:p@127.0.0.1/x', log: capture(), clock, lockWaitMs: 1000, lockRetryMs: 250, pgModule: stub.pgModule }).load(), (e) => e.code === 'ELOCKED');
  assert.deepEqual(clock.sleeps, [250, 250, 250, 250]);
  assert.ok(Date.now() - t0 < 1000);
});

test('a connection lost while the boot is still connecting is destroyed at once, and the first cause is the one reported', async () => {
  let destroyedAtFirstQuery;
  const stub = stubPg({
    pids: [1, 2], holder: 1,
    onConnect: (c) => c.handlers.error(Object.assign(new Error('x'), { code: '57P01', severity: 'FATAL' })), // the server shuts down under us
    onQuery: (c) => { if (destroyedAtFirstQuery === undefined) destroyedAtFirstQuery = c.destroyed === true; },
  });
  await assert.rejects(createPgStore({ url: 'postgres://u:p@127.0.0.1/x', log: capture(), connectBudgetMs: 0, pgModule: stub.pgModule }).load(), (e) => e.code === 'PG_57P01');
  assert.equal(destroyedAtFirstQuery, true);
});

test('classify: the kind of every failure, in one table', () => {
  const kind = (code) => classify(new StoreError(code, 'x')).kind;
  assert.equal(kind('EEPOCH'), 'fence');
  for (const c of ['ECONNRESET', 'PG_57P01', 'PG_08006', 'PG_55P03', 'ENOENT']) assert.equal(kind(c), 'connection', c);
  for (const c of ['PG_57014', 'PG_23514', 'PG_28P01', 'PG_42501']) assert.equal(kind(c), 'statement', c);
  for (const c of ['ELOCKED', 'EPOOLER', 'EIMPORT', 'ETABLEOWNER', 'EFUTURESCHEMA', 'EPG']) assert.equal(kind(c), 'permanent', c);
  assert.equal(classify(Object.assign(new Error('x'), { code: '57014', severity: 'ERROR' })).code, 'PG_57014');
});

withHarness('a boot is retried when the first connections are dropped (Connection terminated unexpectedly, mapped to ECONNRESET)', async (h) => {
  const proxy = await makeProxy();
  try {
    proxy.refuseNext(2);
    const t0 = Date.now();
    const s = await h.open({ url: proxy.url, connectBudgetMs: 20000 });
    assert.equal(s.health().ok, true);
    assert.ok(Date.now() - t0 >= 1400, 'two retries, 500 ms then 1000 ms');
  } finally { await proxy.close(); }
});

// A stand-in for the pg module: queries answer from a script, so a test can say what a pooler would do. Each client created gets
// the next pid of `pids` as its backend (the writer first, then the probe); `holder` is what pg_locks shows for the lock.
function stubPg({ pids, holder, onQuery, onConnect }) {
  const queries = [];
  const made = [];
  const FakeClient = class {
    constructor() { this.pid = pids.shift(); this.handlers = {}; this.connection = { stream: { destroy: () => { this.destroyed = true; } } }; made.push(this); }
    on(ev, fn) { this.handlers[ev] = fn; }
    async connect() { if (onConnect) await onConnect(this); }
    async end() { this.ended = true; }
    async query(sql, params) {
      queries.push(sql);
      if (onQuery) { const r = await onQuery(this, sql, params); if (r !== undefined) return r; }
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ got: true, pid: this.pid }] };
      if (/^SELECT pg_backend_pid/.test(sql)) return { rows: [{ pid: this.pid }] };
      if (/pg_locks/.test(sql)) return { rows: [{ pid: holder }] };
      throw Object.assign(new Error('stub stops here'), { code: 'XX000', severity: 'ERROR' });
    }
  };
  return { queries, made, pgModule: { Client: FakeClient } };
}

test('a connection that is not a real session is refused with EPOOLER: a second pid query that differs, or a probe connection on the writer\'s or the lock holder\'s backend', async () => {
  const log = capture();
  const load = (stub) => createPgStore({ url: 'postgres://u:p@127.0.0.1/x', log, pgModule: stub.pgModule }).load();
  const pooler = (e) => e instanceof StoreError && e.code === 'EPOOLER';
  // the same writer, whose second pid query comes back different (the lock query answered 11, then 12)
  const differs = stubPg({ pids: [11, 99], holder: 11, onQuery: (c, sql) => (/^SELECT pg_backend_pid/.test(sql) ? { rows: [{ pid: 12 }] } : undefined) });
  await assert.rejects(load(differs), pooler);
  assert.equal(differs.made[0].destroyed, true, 'and the connection is let go');
  await assert.rejects(load(stubPg({ pids: [11, 11], holder: 55 })), pooler, 'the probe is the writer\'s own backend');
  await assert.rejects(load(stubPg({ pids: [11, 77], holder: 77 })), pooler, 'the probe is the lock holder\'s backend');
  await assert.rejects(load(stubPg({ pids: [11, 99], holder: 11 })), (e) => e.code === 'PG_XX000', 'a different backend goes on');
});

test('a boot classifies the error that ended the connection, not the "not queryable" that follows: a wrong password reported through the connection fails at once', async () => {
  const handlers = {};
  const FakeClient = class {
    on(ev, fn) { handlers[ev] = fn; }
    async connect() {
      handlers.error(Object.assign(new Error('x'), { code: '28P01', severity: 'FATAL' }));
      handlers.end(); // the end of the session follows the error: it must not replace it as the cause
      throw new Error('Client is not queryable');
    }
    async end() {}
  };
  const t0 = Date.now();
  await assert.rejects(createPgStore({ url: 'postgres://u:p@127.0.0.1/x', log: capture(), connectBudgetMs: 4000, pgModule: { Client: FakeClient } }).load(), (e) => e.code === 'PG_28P01');
  assert.ok(Date.now() - t0 < 1500, 'not retried');
});

withHarness('a statement that is held up for longer than its own timeout but is answered in the end is not fatal: the watchdog slack is generous', async (h) => {
  const proxy = await makeProxy();
  try {
    const fatals = [];
    const s = await h.open({ url: proxy.url, debounceMs: 20, statementTimeoutMs: 300, watchdogSlackMs: 1500, onFatal: (e) => fatals.push(e) });
    proxy.stallAfter(/FOR UPDATE/);
    s.state.rooms.set('room0001', minimalRoom('room0001'));
    s.save('room0001');
    await waitFor(() => proxy.isStalled(), (v) => v === true, { intervalMs: 10, what: 'the write to be held up' });
    await sleep(650); // past the statement timeout, inside the slack
    assert.equal(fatals.length, 0);
    proxy.release();
    assert.equal(await s.settle(), true);
    assert.equal(await roomCount(), 1);
    assert.equal(fatals.length, 0);
  } finally { await proxy.close(); }
});

withHarness('a boot that loses its connection while it waits for the lock retries, and boots once the lock is free', async (h) => {
  const holder = await h.open();
  const loading = h.open({ lockWaitMs: 20000, lockRetryMs: 100, connectBudgetMs: 20000 });
  loading.catch(() => {});
  const holderPids = await lockPids();
  const waiting = await waitFor(async () => (await q('SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND pid <> ALL($1::int[])', [holderPids])).rows, (rows) => rows.length >= 1, { intervalMs: 20, what: 'the second store to connect and wait' });
  await q('SELECT pg_terminate_backend($1)', [waiting[0].pid]); // an idle drop, the way a restarting database or a pooler does it
  await sleep(700); // it retries (500 ms backoff) and waits again
  await holder.close();
  const s = await loading;
  assert.equal(s.health().ok, true);
  assert.equal(h.log.has('store.load_failed'), false);
});

withHarness('a table owned by another role, or a view or a table of the same name that is not ours, is refused with ETABLEOWNER, and nothing is changed', async (h) => {
  const role = 'behalf_other_' + require('crypto').randomBytes(4).toString('hex');
  await dropTable();
  await q(`CREATE ROLE ${role}`);
  try {
    await q('CREATE TABLE behalf_records (kind text NOT NULL, id text NOT NULL, doc text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (kind, id))');
    await q(`ALTER TABLE behalf_records OWNER TO ${role}`);
    await assert.rejects(createPgStore({ url: URL_, log: h.log, connectBudgetMs: 0 }).load(), (e) => e instanceof StoreError && e.code === 'ETABLEOWNER');
    assert.equal((await q('SELECT count(*) FROM behalf_records')).rows[0].count, '0', 'no meta row was added');
    await waitFor(() => lockPids(), (p) => p.length === 0, { intervalMs: 20, what: 'the lock to be given back' });
    await dropTable();
    await q("CREATE VIEW behalf_records AS SELECT 'a'::text AS kind, 'b'::text AS id, 'c'::text AS doc");
    await q(`ALTER VIEW behalf_records OWNER TO ${role}`);
    await assert.rejects(createPgStore({ url: URL_, log: h.log, connectBudgetMs: 0 }).load(), (e) => e instanceof StoreError && e.code === 'ETABLEOWNER', 'a view of another role');
    await q('DROP VIEW behalf_records');
    await q("CREATE VIEW behalf_records AS SELECT 'a'::text AS kind, 'b'::text AS id, 'c'::text AS doc");
    await assert.rejects(createPgStore({ url: URL_, log: h.log, connectBudgetMs: 0 }).load(), (e) => e instanceof StoreError && e.code === 'ETABLEOWNER', 'a view of our own is still not a table');
  } finally {
    await q('DROP VIEW IF EXISTS behalf_records');
    await dropTable();
    await q(`DROP ROLE IF EXISTS ${role}`);
  }
});

test('warnsNoTls uses pg\'s own parser: it warns for TLS that is off or unchecked on a remote host, and for a url that does not parse', { skip: !hasPg }, () => {
  for (const url of ['postgres://u:p@db.example.com/x', 'postgres://u:p@db.example.com/x?sslmode=disable', 'postgres://u:p@db.example.com/x?sslmode=no-verify',
    'postgres://u:p@10.0.0.5:5432/x', 'postgres://u:p@db.example.com/x?ssl=true&sslmode=disable', 'postgres://u:p@db.example.com/x?ssl=1&sslmode=no-verify',
    'postgres://u:p@localhost/x?host=remote', 'postgres://u:p@127.evil.example/x', 'postgres://u:p@db.example.com/x?uselibpqcompat=true&sslmode=require', 'postgres://u:p@[2001:db8::1]/x']) {
    assert.equal(warnsNoTls(url), true, url);
  }
  for (const bad of [undefined, null, 5, {}]) assert.equal(warnsNoTls(bad), true, 'a url that does not parse: ' + String(bad));
  for (const url of ['postgres://u:p@db.example.com/x?sslmode=verify-full', 'postgres://u:p@db.example.com/x?ssl=true', 'postgres://u:p@127.0.0.1/x', 'postgres://u:p@localhost/x',
    'postgres://u:p@[::1]/x', 'postgres:///x?host=/var/run/postgresql', 'postgres://u:p@%2Fvar%2Frun%2Fpostgresql/x']) {
    assert.equal(warnsNoTls(url), false, url);
  }
});

// ---- bootApp and index.js with DATABASE_URL ----

withHarness('bootApp with DATABASE_URL builds the Postgres store, imports rooms.json, deletes the variable, and drain writes and closes', async (h, t) => {
  const saved = process.env.DATABASE_URL;
  t.after(() => { if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved; });
  process.env.DATABASE_URL = URL_;
  const dir = mkTmp('pg-boot-');
  t.after(() => rmTmp(dir));
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ schemaVersion: 1, rooms: { room0001: legacyRoom('room0001', 'a') } }));
  const config = loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: dir, PUBLIC_URL: 'http://test.invalid' });
  const app = await bootApp({ config, log: h.log, proxy: fakeProxy(), clock: { sleep: async () => {} } });
  assert.equal('DATABASE_URL' in process.env, false);
  assert.equal(app.store.kind, 'postgres');
  assert.ok(app.domain.rooms.has('room0001'), 'imported');
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('rooms.json.imported-')).length, 1);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const j = await (await fetch(`http://127.0.0.1:${app.server.address().port}/health`)).json();
  assert.equal(j.store, 'postgres');
  assert.equal(j.storeOk, true);
  const demo = app.domain.createDemoRoom();
  assert.equal(await app.drain(), true);
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room' AND id = $1", [demo.id])).rows[0].count, '1');
  assert.equal(app.server.listening, false);
});

test('bootApp passes the database url through the redacted secrets: a url in secrets selects Postgres', DB, async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const config = loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: mkTmp('pg-boot2-'), PUBLIC_URL: 'http://test.invalid' });
  t.after(() => rmTmp(config.dataDir));
  const app = await bootApp({ config, secrets: loadSecrets({ DATABASE_URL: URL_ }), log: h.log, proxy: fakeProxy(), storeOptions: { debounceMs: 20 } });
  assert.equal(app.store.kind, 'postgres');
  await app.drain();
});

test('bootApp rejects with ELOCKED while another store holds the lock, and the holder is not disturbed', DB, async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const fatals = [];
  const holder = await h.open({ onFatal: (e) => fatals.push(e) });
  const config = loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: mkTmp('pg-boot3-'), PUBLIC_URL: 'http://test.invalid' });
  t.after(() => rmTmp(config.dataDir));
  await assert.rejects(bootApp({ config, secrets: loadSecrets({ DATABASE_URL: URL_ }), log: h.log, proxy: fakeProxy(), storeOptions: { lockWaitMs: 200, lockRetryMs: 50 } }), (e) => e.code === 'ELOCKED');
  holder.state.rooms.set('room0001', minimalRoom('room0001'));
  holder.save('room0001');
  assert.equal(await holder.settle(), true);
  assert.equal(fatals.length, 0);
});

test('index.js: a wrong password logs store.load_failed with the SQLSTATE code, never the url or the password, and exits 1 before listening', DB, async () => {
  const dir = mkTmp('pg-index-');
  try {
    const bad = URL_.replace(/\/\/([^:]+):[^@]*@/, '//$1:SECRET-WRONG-PW@');
    const p = spawnIndex(dir, { DATABASE_URL: bad });
    const r = await p.exited;
    assert.equal(r.code, 1, r.out);
    const lines = r.out.split('\n').filter((l) => l.includes('store.load_failed'));
    assert.equal(lines.length, 1, r.out);
    assert.match(lines[0], /code="PG_28/);
    assert.ok(!r.out.includes('SECRET-WRONG-PW') && !r.out.includes(bad) && !/on :\d+ /.test(r.out));
  } finally { rmTmp(dir); }
});


test('index.js on Postgres: serves, keeps rooms in the database, and SIGTERM drains and exits 0 with the room durable', DB, async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const dir = mkTmp('pg-index-run-');
  const trigger = path.join(mkTmp('pg-trigger-'), 'go');
  t.after(() => { rmTmp(dir); rmTmp(path.dirname(trigger)); });
  const preload = path.join(ROOT, 'test-support', 'sigterm-preload.js');
  const p = spawnIndex(dir, { DATABASE_URL: URL_, SIGTERM_TRIGGER: trigger }, ['-r', preload]);
  const port = await p.listening;
  assert.ok(port, p.out());
  assert.match(p.stdout().split('\n')[0], /^Behalf \(PXP\/0\) on :\d+ /, 'the listen line is the first line');
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.deepEqual([health.store, health.storeOk], ['postgres', true]);
  const { id } = await (await fetch(`http://127.0.0.1:${port}/api/demo`, { method: 'POST' })).json();
  fs.writeFileSync(trigger, '');
  const r = await p.exited;
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 0, signal: null }, r.out);
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room' AND id = $1", [id])).rows[0].count, '1');
  assert.ok(!r.out.includes(URL_), 'the url is not in the output');
});

// ---- the first write, the table owner, boot ----
const xmins = async () => Object.fromEntries((await q('SELECT kind || \'/\' || id AS k, xmin::text AS x FROM behalf_records')).rows.map((r) => [r.k, r.x]));

withHarness('the first write after a load carries only what hydrate() changed: no change upserts 0 rows, one change exactly 1', async (h) => {
  const s = await h.open();
  for (let i = 1; i <= 5; i++) { const id = 'room000' + i; s.state.rooms.set(id, minimalRoom(id)); }
  s.state.usage.day = 'd'; s.state.usage.total = 3;
  s.collection('user').map.set('u1', { id: 'u1' });
  s.save();
  s.collection('user').save();
  s.saveUsage();
  assert.equal(await s.settle(), true);
  await s.close();
  const before = await xmins();
  const s2 = await h.open(); // every kind starts all-dirty
  assert.equal(await s2.settle(), true);
  assert.deepEqual(await xmins(), { ...before, 'meta/schema': (await xmins())['meta/schema'] }, 'no row was written again (only meta, by the load)');
  s2.state.rooms.get('room0003').status = 'paused'; // what hydrate() does
  s2.save();
  assert.equal(await s2.settle(), true);
  const after = await xmins();
  const changed = Object.keys(after).filter((k) => k !== 'meta/schema' && after[k] !== before[k]);
  assert.deepEqual(changed, ['room/room0003']);
});


withHarness('bootApp closes the store it built when createApp throws, so the lock is free again', async (h, t) => {
  const dir = mkTmp('pg-boot4-');
  t.after(() => rmTmp(dir));
  const config = { ...loadConfig({ SIGNIN: 'off', DROP_DATA_DIR: dir, PUBLIC_URL: 'http://test.invalid' }), trustProxy: 'bogus' };
  await assert.rejects(bootApp({ config, secrets: loadSecrets({ DATABASE_URL: URL_ }), log: h.log, proxy: fakeProxy() }), /Unknown trust proxy/);
  await waitFor(() => lockPids(), (p) => p.length === 0, { intervalMs: 20, what: 'the lock to be given back' });
  await h.open(); // loads at once
});

test('index.js on Postgres: SIGTERM exits 1 when the final write fails', DB, async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const dir = mkTmp('pg-index-fail-');
  const trigger = path.join(mkTmp('pg-trigger2-'), 'go');
  t.after(() => { rmTmp(dir); rmTmp(path.dirname(trigger)); });
  const p = spawnIndex(dir, { DATABASE_URL: URL_, SIGTERM_TRIGGER: trigger }, ['-r', path.join(ROOT, 'test-support', 'sigterm-preload.js')]);
  const port = await p.listening;
  assert.ok(port, p.out());
  await q("ALTER TABLE behalf_records ADD CONSTRAINT nope CHECK (kind <> 'room') NOT VALID");
  await fetch(`http://127.0.0.1:${port}/api/demo`, { method: 'POST' });
  fs.writeFileSync(trigger, '');
  const r = await p.exited;
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 1, signal: null }, r.out);
  assert.match(r.out, /event="store\.write_failed"/);
});

test('index.js on Postgres: the store connection is lost, so the process logs store.lock_lost and exits 1', DB, async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const dir = mkTmp('pg-index-lost-');
  t.after(() => rmTmp(dir));
  const p = spawnIndex(dir, { DATABASE_URL: URL_ });
  const port = await p.listening;
  assert.ok(port, p.out());
  const [pid] = await lockPids();
  await q('SELECT pg_terminate_backend($1)', [pid]);
  const r = await p.exited;
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /event="store\.lock_lost"/);
});

// ---- a real-shaped rooms.json through Postgres ----
withImport('import: the real-shaped v0 fixture (rooms.v0.json) comes through the import and a restart with every ledger still verifying and byte-equal', async (h, { file }) => {
  const pxp = require('../lib/pxp');
  const text = fs.readFileSync(path.join(ROOT, 'test-support', 'fixtures', 'rooms.v0.json'), 'utf8');
  const fixture = JSON.parse(text);
  const ids = Object.keys(fixture.rooms).sort();
  assert.ok(ids.length >= 3 && ids.some((id) => fixture.rooms[id].ledger.length > 1), 'fixture precondition: several rooms, with real ledgers');
  fs.writeFileSync(file, text);
  const s1 = await h.open({ importFile: file });
  assert.equal(h.log.has('store.imported'), true);
  assert.deepEqual([...s1.state.rooms.keys()].sort(), ids, 'every room was imported');
  await s1.settle();
  await s1.close();
  const s2 = await h.open({ importFile: file }); // a restart: everything now comes from the table
  assert.deepEqual([...s2.state.rooms.keys()].sort(), ids);
  for (const id of ids) {
    const room = s2.state.rooms.get(id);
    assert.equal(pxp.verifyLedger(room.ledger).ok, true, id);
    assert.deepEqual(room.ledger, fixture.rooms[id].ledger, id + ': the ledger is exactly what the file held');
  }
});

test('index.js on Postgres: SIGINT drains and exits 130 with the room durable', DB, async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const dir = mkTmp('pg-index-int-');
  const trigger = path.join(mkTmp('pg-trigger3-'), 'go');
  t.after(() => { rmTmp(dir); rmTmp(path.dirname(trigger)); });
  const p = spawnIndex(dir, { DATABASE_URL: URL_, SIGTERM_TRIGGER: trigger, SIGNAL_NAME: 'SIGINT' }, ['-r', path.join(ROOT, 'test-support', 'sigterm-preload.js')]);
  const port = await p.listening;
  assert.ok(port, p.out());
  const { id } = await (await fetch(`http://127.0.0.1:${port}/api/demo`, { method: 'POST' })).json();
  fs.writeFileSync(trigger, '');
  const r = await p.exited;
  assert.deepEqual({ code: r.code, signal: r.signal }, { code: 130, signal: null }, r.out);
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room' AND id = $1", [id])).rows[0].count, '1', 'flushed before leaving');
});

for (const [label, content] of [['is not JSON', '{"rooms": SECRET-garbage not json'], ['has the wrong top-level shape', '["not","an","object"]'], ['is a JSON string', '"rooms"']]) {
  withImport(`import (D4): a rooms.json that ${label} is renamed to rooms.json.corrupt-<ts>, logs store.import_quarantined, and the store starts empty and works`, async (h, { dir, file, names }) => {
    fs.writeFileSync(file, content);
    const s = await h.open({ importFile: file });
    assert.equal(h.log.lines.filter((l) => l.event === 'store.import_quarantined').length, 1, h.log.events().join());
    assert.equal(h.log.lines.find((l) => l.event === 'store.import_quarantined').level, 'error');
    assert.equal(h.log.has('store.imported'), false);
    const left = names();
    assert.equal(left.length, 1, left.join());
    assert.match(left[0], /^rooms\.json\.corrupt-/);
    assert.equal(fs.readFileSync(path.join(dir, left[0]), 'utf8'), content, 'kept byte for byte');
    assert.equal(s.state.rooms.size, 0);
    assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room'")).rows[0].count, '0');
    s.state.rooms.set('room0001', minimalRoom('room0001'));
    s.save();
    assert.equal(await s.settle(), true, 'it serves: a new room is written');
    assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room'")).rows[0].count, '1');
    assert.ok(!JSON.stringify(h.log.lines.map((l) => [l.event, l.fields])).includes('SECRET-garbage'));
  });
}

withImport('import (D4): a rooms.json that cannot be read is EIMPORT and stays where it is: no rename, no quarantine, nothing written', async (h, { dir, file, names }) => {
  fs.mkdirSync(file); // reading a directory fails with EISDIR, not ENOENT
  await assert.rejects(h.open({ importFile: file }), (e) => e instanceof StoreError && e.code === 'EIMPORT');
  assert.deepEqual(names(), ['rooms.json']);
  assert.equal(fs.statSync(file).isDirectory(), true);
  assert.equal(h.log.has('store.import_quarantined'), false);
  assert.equal((await q("SELECT count(*) FROM behalf_records WHERE kind = 'room'")).rows[0].count, '0');
});

test('the last test drops the table', DB, async () => { await dropTable(); });

test('two instances on one database (a redeploy): the new one answers 503 "starting" while the old one holds the lock, then serves the old one\'s rooms', DB, async (t) => {
  const h = await harness();
  t.after(h.cleanup);
  const dirA = mkTmp('pg-redeploy-a-');
  const dirB = mkTmp('pg-redeploy-b-');
  const trigger = path.join(mkTmp('pg-redeploy-trigger-'), 'go');
  t.after(() => { rmTmp(dirA); rmTmp(dirB); rmTmp(path.dirname(trigger)); });
  const a = spawnIndex(dirA, { DATABASE_URL: URL_, SIGTERM_TRIGGER: trigger }, ['-r', path.join(ROOT, 'test-support', 'sigterm-preload.js')]);
  t.after(() => a.stop());
  const portA = await a.listening;
  assert.ok(portA, a.out());
  const { id } = await (await fetch(`http://127.0.0.1:${portA}/api/demo`, { method: 'POST' })).json();
  const portB = String(48100 + Math.floor(Math.random() * 800));
  const b = spawnIndex(dirB, { DATABASE_URL: URL_, PORT: portB });
  t.after(() => b.stop());
  const base = `http://127.0.0.1:${portB}`;
  const early = await waitFor(async () => { try { return await fetch(base + '/health'); } catch (e) { return null; } }, (r) => r !== null, { timeoutMs: 2000, what: 'the placeholder' });
  assert.equal(early.status, 503);
  assert.deepEqual(await early.json(), { ok: false, starting: true });
  assert.equal(b.stdout(), '', 'B is not listening yet: no listen line');
  fs.writeFileSync(trigger, ''); // A is stopped: it drains and releases the lock
  assert.equal((await a.exited).code, 0, a.out());
  assert.equal(await b.listening, Number(portB), b.out());
  const health = await (await fetch(base + '/health')).json();
  assert.deepEqual([health.ok, health.store], [true, 'postgres']);
  assert.equal((await fetch(`${base}/api/rooms/${id}`)).status, 200, 'the room made on A is readable on B');
});
