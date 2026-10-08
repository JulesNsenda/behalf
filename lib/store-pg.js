'use strict';
// The Postgres sink: the same public API as lib/store.js, over the shared core (lib/store-core.js). The in-memory state stays the
// runtime source of truth and the domain stays synchronous; this file loads it from, and writes it behind to, ONE table:
//   behalf_records (kind, id, doc text, updated_at), PRIMARY KEY (kind, id)
// doc is text, not jsonb: JSON.stringify escapes NUL and lone surrogates as ASCII, so Postgres can never refuse a row for its
// content. kind is room, user, session, agentkey, aiaccess, usage (id 'today') or meta (id 'schema': { version, epoch, importedFrom?,
// importedAt?, importedSha256? }). Every data value goes through a $n placeholder. `pg` is required inside load() only, so the
// file store, local dev and the suite need no node_modules.
//
// One connection holds the session advisory lock and runs every transaction. The platform runs one instance, stop then start,
// so the HOLDER WINS: a boot that cannot get the lock within lockWaitMs fails with ELOCKED and the process exits (a live but
// hung old process keeps the lock until it is killed). A direct or session-mode URL is required: behind a transaction-mode
// pooler locks and SETs mean nothing, which the boot checks (EPOOLER; best-effort).
// Losing the store is FATAL and the process is expected to exit: the connection ends or errors, a statement gets no answer at
// all within its watchdog, or the epoch changes. The store logs store.lock_lost (store.connection_lost for the watchdog), closes
// for good and calls onFatal(err) once. The platform restarts the process, which reloads from the database. Nothing reconnects.
// The epoch fence: load() writes a fresh random epoch into the meta row, and every later transaction (a write, the import, the
// migration rewrite) starts by locking that row and refusing to go on if the epoch is not its own.
// Zombies are reaped by the server: idle_in_transaction_session_timeout covers a holder stuck inside a transaction, and the TCP
// keepalive settings reap a dead peer that holds the lock OUTSIDE a transaction. Do NOT add idle_session_timeout: it would kill
// the legitimate holder, which is idle between writes.
//
// The write cycle (single flight, backoff, health, drain) is core.createWriteCycle; writeOnce is one fenced transaction of
// batched upserts and deletes. A database error is wrapped as StoreError('PG_<SQLSTATE>') before it reaches the logger;
// messages, rows and the URL are never logged. close() and drain() end the connection only after the write in flight has
// settled, and never reject.
const fs = require('fs');
const crypto = require('crypto');

const core = require('./store-core');
const { isLoopbackPeer } = require('./net');
const { SCHEMA_VERSION, StoreError, KIND, best } = core;

const DEBOUNCE_MS = 300;
const LOCK_WAIT_MS = 45000;
const LOCK_RETRY_MS = 250;
// The writer session's statement_timeout. It is tied to the drain deadline (DRAIN_DEADLINE_MS, default 4000, lib/config.js) and the
// platform's kill timeout (Drop: PM2 5 s, Docker 10 s): a final write that hangs gives up after this, and the release that
// follows is bounded by its own two deadlines of 2 s, so keep it under the drain default. Change one, check the others.
const STATEMENT_MS = 3000;
const WATCHDOG_SLACK_MS = 20000; // a statement not answered at all this long after its own timeout: the connection is dead
const IDLE_TX_MS = 10000; // idle_in_transaction_session_timeout of the writer session
const LOCK_TIMEOUT_MS = 10000; // the epoch claim waits this long for the meta row
const READ_MS = 30000; // the setup, read and migration transactions
const IMPORT_MS = 60000;
const CONNECT_BUDGET_MS = 45000; // a boot attempt, retried with backoff
const CONNECT_RETRY_MS = 500;
const CHUNK = 100; // rows per statement
const LOCK_CLASS = 1650092134; // the first int of the lock key (the second is the database name's hash)

const TABLE_SQL = 'CREATE TABLE IF NOT EXISTS behalf_records (kind text NOT NULL, id text NOT NULL, doc text NOT NULL, '
  + 'updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (kind, id))';
const OWNER_SQL = "SELECT c.relkind = 'r' AND pg_get_userbyid(c.relowner) = current_user AS mine FROM pg_class c WHERE c.oid = to_regclass('behalf_records')";
const UPSERT_SQL = 'INSERT INTO behalf_records (kind, id, doc) SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) '
  + 'ON CONFLICT (kind, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()';
const DELETE_SQL = 'DELETE FROM behalf_records WHERE kind = $1 AND id = ANY($2::text[])';
const META_SQL = "SELECT doc FROM behalf_records WHERE kind = 'meta' AND id = 'schema' FOR UPDATE";
const META_INSERT_SQL = "INSERT INTO behalf_records (kind, id, doc) VALUES ('meta', 'schema', $1) ON CONFLICT (kind, id) DO NOTHING";
const META_UPDATE_SQL = "UPDATE behalf_records SET doc = $1, updated_at = now() WHERE kind = 'meta' AND id = 'schema'";
const TRY_LOCK_SQL = 'SELECT pg_try_advisory_lock($1::int4, hashtext(current_database())) AS got, pg_backend_pid() AS pid';
const UNLOCK_SQL = 'SELECT pg_advisory_unlock($1::int4, hashtext(current_database()))';
const PID_SQL = 'SELECT pg_backend_pid() AS pid';
const HOLDER_SQL = "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND classid = $1::oid"
  + ' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND objid = hashtext(current_database())::oid';
const TIMEOUT_SQL = "SELECT set_config('statement_timeout', $1, true)";
const LOCK_TIMEOUT_SQL = "SELECT set_config('lock_timeout', $1, true)";
const SELECT_ALL_SQL = 'SELECT kind, id, doc FROM behalf_records';

// A database or driver error to a StoreError whose code the logger keeps: PG_<SQLSTATE> for an error from the server, the
// Node code for a socket error, ECONNRESET for a connection the driver reports as ended, ETIMEDOUT for a driver timeout, any other
// Node code as it is (MODULE_NOT_FOUND: `pg` is not installed; ERR_INVALID_URL), EPGAUTH for the driver's own password (SASL)
// failures, EPG_<CLASS> for an error of another class (EPG_TYPEERROR), else EPG. The original goes in `cause` and is never logged.
function pgError(e) {
  if (e instanceof StoreError) return e;
  let code = 'EPG';
  const msg = e && typeof e.message === 'string' ? e.message : '';
  const cls = e instanceof Error && typeof e.constructor.name === 'string' ? e.constructor.name : '';
  if (e && typeof e.code === 'string' && typeof e.severity === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) code = 'PG_' + e.code;
  else if (core.safeCode(e)) code = core.safeCode(e);
  else if (e && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(e.code)) code = e.code;
  else if (/connection terminated|not queryable/i.test(msg)) code = 'ECONNRESET';
  else if (/timeout|timed out/i.test(msg)) code = 'ETIMEDOUT';
  else if (/SASL|password/i.test(msg)) code = 'EPGAUTH';
  else if (/^[A-Za-z]{1,30}$/.test(cls) && cls !== 'Error') code = 'EPG_' + cls.toUpperCase();
  return new StoreError(code, 'a Postgres operation failed', e);
}

// What a failure means, in one table. kind: 'connection' (the connection is gone or unreachable: a boot retries it, a running
// store is lost), 'fence' (another process claimed the store: a running store is lost), 'statement' (the server refused a
// statement; it was rolled back and a running store backs off and retries it) or 'permanent' (anything else: a boot fails at
// once). PG_55P03 is the claim's lock_timeout: only boot sets one, and it is retried.
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'PG_57P03', 'PG_57P01', 'PG_57P02', 'PG_53300', 'PG_55P03']);
function classify(e) {
  const err = pgError(e);
  const { code } = err;
  let kind = 'permanent';
  if (code === 'EEPOCH') kind = 'fence';
  else if (CONNECTION_CODES.has(code) || code.startsWith('PG_08')) kind = 'connection';
  else if (code.startsWith('PG_')) kind = 'statement';
  return { err, code, kind };
}

const nul = () => Object.create(null); // a row id such as __proto__ must stay an ordinary key
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }; // referenced timers: a boot waiting to retry keeps the process up

// Whether the traffic to this url is unencrypted and leaves the machine: no TLS (per pg's own parser) on a host that is not a
// socket path, localhost or a loopback address; or TLS without certificate checking; or a url that does not parse.
function warnsNoTls(url) {
  let cfg;
  try { cfg = require('pg-connection-string').parse(url); } catch (e) { return true; }
  if (cfg.ssl && cfg.ssl.rejectUnauthorized === false) return true;
  if (cfg.ssl) return false;
  const host = String(cfg.host || '');
  return !(host === '' || host.startsWith('/') || host === 'localhost' || isLoopbackPeer(host));
}

// The rows as a store document, its top-level keys from the kind table (kinds is KIND; a test passes its own). A row whose text
// is not JSON becomes null, which the core skips and counts like any unusable record. texts keeps each row's text, to seed the
// serialiser.
function rowsToDoc(rows, version, log, kinds = KIND) {
  const raw = { schemaVersion: version };
  for (const def of Object.values(kinds)) if (!def.singleton) raw[def.key] = nul();
  const texts = Object.fromEntries(Object.keys(kinds).map((k) => [k, new Map()]));
  for (const { kind, id, doc } of rows) {
    if (!Object.hasOwn(kinds, kind)) continue; // meta, or a kind this build does not know
    const def = kinds[kind];
    texts[kind].set(id, doc);
    let rec = null;
    try { rec = JSON.parse(doc); } catch (e) { /* skipped below */ }
    if (def.singleton) {
      if (id === def.singleton) {
        if (rec === null) log.error('store.record_skipped', {}); else raw[def.key] = rec;
      }
      continue;
    }
    raw[def.key][id] = rec;
  }
  return { raw, texts };
}

// clock is optional: { now, sleep, setTimeout, clearTimeout }, each defaulting to the real one (the domain's { now, sleep } fits):
// now and sleep serve the boot's retry and lock loops and the failure stamp, the timers serve the write cycle.
// onFatal(err) is called once when the store is lost. Options for tests: lockWaitMs, lockRetryMs, connectBudgetMs,
// statementTimeoutMs, watchdogSlackMs, idleTxMs, lockTimeoutMs, pgModule (a stand-in for require('pg')).
function createPgStore({ url, log, importFile, clock, debounceMs = DEBOUNCE_MS, lockWaitMs = LOCK_WAIT_MS, lockRetryMs = LOCK_RETRY_MS,
  connectBudgetMs = CONNECT_BUDGET_MS, statementTimeoutMs = STATEMENT_MS, watchdogSlackMs = WATCHDOG_SLACK_MS, idleTxMs = IDLE_TX_MS,
  lockTimeoutMs = LOCK_TIMEOUT_MS, pgModule, onFatal }) {
  const data = core.createData();
  const { state } = data;
  const serialiser = core.createSerialiser(log);
  const clk = { now: (clock && clock.now) || realClock.now, sleep: (clock && clock.sleep) || realClock.sleep };
  let phase = 'connecting'; // connecting (load not done) | open | lost | closing | closed
  let client = null;
  let ended = false; // this client's connection has ended or errored
  let cause = null; // the first thing that ended the connection: it says more than the errors that follow it
  let epoch = null;
  let pg = null;
  let released = null;

  function destroyConn() {
    ended = true;
    if (client) best(() => client.connection.stream.destroy());
  }

  // The one place a lost connection is handled, whoever notices it (a listener, a deadline, a rejected statement). The first
  // cause is recorded. While connecting that is all (the boot attempt reads it); when open the store is lost for good.
  function connectionLost(err, event) {
    const lost = pgError(err === undefined ? Object.assign(new Error('the connection ended'), { code: 'ECONNRESET' }) : err);
    if (!cause) cause = lost;
    if (phase === 'connecting') { destroyConn(); return; }
    if (phase !== 'open') return;
    phase = 'lost';
    log.error(event, {}, cause);
    destroyConn();
    cycle.api.lose(clk.now());
    try { if (onFatal) onFatal(cause); } catch (e) { /* the owner's problem */ }
  }

  // A promise that gives up after ms: onTimeout(err) says what the loss means (by default the connection is lost), and it is
  // rejected with err. A statement not answered at all means a dead connection.
  function deadline(ms, promise, onTimeout = (err) => connectionLost(err, 'store.connection_lost')) {
    let timer;
    const limit = new Promise((resolve, reject) => {
      timer = setTimeout(() => { const err = new StoreError('ETIMEDOUT', 'a Postgres statement got no answer'); onTimeout(err); reject(err); }, ms);
    });
    promise.catch(() => {}); // the loser of the race must not be unhandled
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  }

  // A new connection with the session set up (the server reaps what we cannot), then the advisory lock. The listeners are
  // attached once, before the connect, and only count for this client.
  async function connectAndLock() {
    ended = false;
    cause = null;
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, keepAlive: true });
    c.on('error', (e) => { if (c === client) connectionLost(e, 'store.lock_lost'); });
    c.on('end', () => { if (c === client) connectionLost(undefined, 'store.lock_lost'); });
    client = c;
    try { await c.connect(); } catch (e) { ended = true; throw e; }
    // An error here is ignored (on a Unix socket the keepalive settings are no-ops) unless the connection is dead.
    for (const sql of [`SET statement_timeout = ${Number(statementTimeoutMs)}`, `SET idle_in_transaction_session_timeout = ${Number(idleTxMs)}`,
      'SET tcp_keepalives_idle = 10', 'SET tcp_keepalives_interval = 5', 'SET tcp_keepalives_count = 3']) {
      try { await deadline(5000, c.query(sql)); } catch (e) { if (ended) throw e; }
    }
    const lockUntil = clk.now() + lockWaitMs;
    let writerPid;
    for (;;) {
      const row = (await deadline(5000, c.query(TRY_LOCK_SQL, [LOCK_CLASS]))).rows[0];
      if (row.got === true) { writerPid = row.pid; break; }
      if (clk.now() >= lockUntil) throw new StoreError('ELOCKED', 'another process holds the store lock');
      await clk.sleep(lockRetryMs);
    }
    // The session must be one backend: two pids that differ, or a second connection landing on the writer's (or the lock
    // holder's) backend, mean a transaction-mode pooler.
    const second = (await deadline(5000, c.query(PID_SQL))).rows[0].pid;
    if (writerPid !== second) throw new StoreError('EPOOLER', 'the connection is behind a transaction-mode pooler');
    const holder = (await deadline(5000, c.query(HOLDER_SQL, [LOCK_CLASS]))).rows[0];
    const probe = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 5000 });
    probe.on('error', () => {});
    try {
      await probe.connect();
      const pid = (await probe.query(PID_SQL)).rows[0].pid;
      if (pid === writerPid || (holder && pid === holder.pid)) throw new StoreError('EPOOLER', 'two connections reached the same backend: a transaction-mode pooler');
    } finally { best(() => { const e = probe.end(); if (e && e.catch) e.catch(() => {}); }); }
  }

  // One transaction on the connection. fn(c) does the work, with c.query. statementMs: a statement_timeout for this transaction
  // only (the session's applies otherwise). fence: first check that the epoch is still ours. lockMs: a lock_timeout. A failed
  // transaction is rolled back. Every statement has its watchdog, re-armed after each one.
  async function inTx(fn, { statementMs = null, fence = false, lockMs = null } = {}) {
    const watchMs = (statementMs === null ? statementTimeoutMs : statementMs) + watchdogSlackMs;
    const c = { query: (sql, params) => deadline(watchMs, client.query(sql, params)) };
    await c.query('BEGIN');
    try {
      if (statementMs !== null) await c.query(TIMEOUT_SQL, [String(statementMs)]);
      if (lockMs !== null) await c.query(LOCK_TIMEOUT_SQL, [String(lockMs)]);
      if (fence) {
        const meta = await c.query(META_SQL); // a database error here is an ordinary failed write
        let ok = false;
        try { ok = JSON.parse(meta.rows[0].doc).epoch === epoch; } catch (e) { /* no row, or not ours */ }
        if (!ok) throw new StoreError('EEPOCH', 'the store was taken over by another process');
      }
      await fn(c);
      await c.query('COMMIT');
    } catch (e) {
      if (!ended) { try { await c.query('ROLLBACK'); } catch (e2) { /* the connection is gone; connectionLost knows */ } }
      throw e;
    }
  }

  async function upsertRows(c, rows) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      await c.query(UPSERT_SQL, [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2])]);
    }
  }

  // Every record of a parsed document as [kind, id, text].
  const rowsOf = (doc) => Object.keys(KIND).flatMap((kind) => doc.records[kind].map(([id, rec]) => [kind, id, KIND[kind].encode(rec)]));

  async function readRows() {
    let rows;
    await inTx(async (c) => { rows = (await c.query(SELECT_ALL_SQL)).rows; }, { statementMs: READ_MS });
    return rows;
  }

  function parseMeta(text) {
    let meta = null;
    try { meta = JSON.parse(text); } catch (e) { /* refused below */ }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !Number.isInteger(meta.version) || meta.version < 0) throw new StoreError('ESHAPE', 'the store metadata is unusable');
    if (meta.version > SCHEMA_VERSION) throw new StoreError('EFUTURESCHEMA', 'the store is from a newer version');
    return meta;
  }

  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

  // Moves rooms.json into the table. The file is only read; it goes in as one fenced transaction (with its SHA-256 recorded in
  // meta), then it is renamed so a later file-store start begins empty rather than from a stale copy. A file that cannot be read,
  // is from a newer version, or has every room unusable stops the boot (EIMPORT): rooms a live tester made are never silently
  // dropped. A file that is not JSON or has the wrong shape holds no rooms to lose: it is set aside as rooms.json.corrupt-<time>
  // and the store starts empty. Returns the new meta, or null.
  async function importLegacy(meta) {
    let buf;
    try { buf = fs.readFileSync(importFile); } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw new StoreError('EIMPORT', 'could not read the file to import', e);
    }
    const doc = core.decodeStoreText(buf.toString('utf8'), log);
    if (doc.error === 'EPARSE' || doc.error === 'ESHAPE') {
      try { fs.renameSync(importFile, core.corruptPath(importFile, clk.now())); } catch (e) { throw new StoreError('EIMPORT', 'could not set the unusable file aside', e); }
      log.error('store.import_quarantined', {});
      return null;
    }
    if (doc.error) throw new StoreError('EIMPORT', 'the file to import is unusable');
    const next = { ...meta, version: SCHEMA_VERSION, importedFrom: 'rooms.json', importedAt: new Date(clk.now()).toISOString(), importedSha256: sha256(buf) };
    const t0 = Date.now();
    await inTx(async (c) => { await upsertRows(c, [...rowsOf(doc), ['meta', 'schema', JSON.stringify(next)]]); }, { statementMs: IMPORT_MS, fence: true });
    renameImported();
    log.info('store.imported', { durationMs: Date.now() - t0 });
    return next;
  }

  function renameImported() {
    try { fs.renameSync(importFile, `${importFile}.imported-${core.stamp(clk.now())}`); return true; } catch (e) { log.error('store.import_rename_failed', {}, e); return false; }
  }

  // At a boot after an import: a file still there is the imported one (a crash fell between the commit and the rename) only if
  // its hash is the one recorded; anything else is left alone.
  function finishRename(meta) {
    if (!isFile(importFile)) return;
    let same = false;
    try { same = typeof meta.importedSha256 === 'string' && sha256(fs.readFileSync(importFile)) === meta.importedSha256; } catch (e) { /* left alone */ }
    if (!same) log.warn('store.import_skipped', {});
    else if (renameImported()) log.info('store.import_rename_finished', {});
  }

  // The setup transaction: the table (refused unless it is a table owned by the current role), the meta row, and the epoch claim.
  // The claim waits for the meta row only lockTimeoutMs, so a zombie's row lock fails the attempt fast (and the boot retries).
  async function claim() {
    epoch = crypto.randomBytes(8).toString('hex');
    let meta;
    await inTx(async (c) => {
      await c.query(TABLE_SQL);
      const own = await c.query(OWNER_SQL);
      if (!(own.rows.length === 1 && own.rows[0].mine === true)) throw new StoreError('ETABLEOWNER', 'behalf_records is not a table owned by the current role');
      await c.query(META_INSERT_SQL, [JSON.stringify({ version: SCHEMA_VERSION })]);
      meta = { ...parseMeta((await c.query(META_SQL)).rows[0].doc), epoch };
      await c.query(META_UPDATE_SQL, [JSON.stringify(meta)]);
    }, { statementMs: READ_MS, lockMs: lockTimeoutMs });
    return meta;
  }

  // A store older than the code: every loaded room is rewritten in one fenced transaction, and meta bumped only if no room was
  // skipped (otherwise the next boot migrates again, which is why migrations are idempotent).
  async function migrate(meta, parsed, texts) {
    const rewritten = parsed.records.room.map(([id, room]) => [id, KIND.room.encode(room)]);
    const bump = parsed.skipped.room.length === 0;
    await inTx(async (c) => {
      await upsertRows(c, rewritten.map(([id, str]) => ['room', id, str]));
      if (bump) await upsertRows(c, [['meta', 'schema', JSON.stringify({ ...meta, version: SCHEMA_VERSION })]]);
    }, { statementMs: READ_MS, fence: true });
    for (const [id, str] of rewritten) texts.room.set(id, str);
  }

  async function readInto() {
    let meta = await claim();
    let rows = await readRows();
    if (importFile) {
      if (meta.importedAt) finishRename(meta);
      else if (rows.every((r) => r.kind === 'meta')) {
        const next = await importLegacy(meta);
        if (next) { meta = next; rows = await readRows(); }
      } else if (isFile(importFile)) log.warn('store.import_skipped', {}); // the table already has data: the file is left alone
    }
    const { raw, texts } = rowsToDoc(rows, meta.version, log);
    const parsed = core.parseStoreDoc(raw, log, { allSkippedFatal: false }); // every room skipped is not fatal: the rows stay
    if (parsed.error) throw new StoreError(parsed.error, 'the stored data cannot be loaded');
    if (meta.version < SCHEMA_VERSION) await migrate(meta, parsed, texts);
    core.applyDoc(data, parsed);
    // The first write carries only what hydrate() changes: the serialiser knows what the table already holds.
    for (const kind of Object.keys(KIND)) for (const [id] of parsed.records[kind]) serialiser.seed(kind, id, texts[kind].get(id));
  }

  // Boot attempts: a connection-class failure is retried with backoff until the budget is used; anything else fails at once.
  async function attempts() {
    const end = clk.now() + connectBudgetMs;
    let delay = CONNECT_RETRY_MS;
    for (;;) {
      try { await connectAndLock(); await readInto(); return; } catch (e) {
        const failure = classify(cause || e); // what ended the connection, not the "not queryable" that follows it
        destroyConn();
        client = null;
        if (failure.kind !== 'connection' || clk.now() >= end) throw failure.err;
        await clk.sleep(Math.min(delay, end - clk.now()));
        delay = Math.min(delay * 2, 8000);
      }
    }
  }

  // A load that throws leaves the store closed: its connection is released.
  async function load() {
    if (pg || client || phase !== 'connecting') throw new StoreError('ELOADED', 'load() was already called');
    const t0 = Date.now();
    try {
      pg = pgModule || require('pg');
      if (warnsNoTls(url)) log.warn('store.no_tls', {});
      await attempts();
    } catch (e) {
      await release();
      throw pgError(e);
    }
    cause = null;
    phase = 'open';
    cycle.setLoaded();
    log.info('store.loaded', { durationMs: Date.now() - t0 }); // the logger's only numeric field: the whole load, not each phase
    return state;
  }

  function resetUsage(day) { core.resetUsage(data, cycle.api, day); }

  // The sink's one I/O step: one fenced transaction. A connection-class or fence failure loses the store (and closes the cycle
  // first, so no write_failed line); a statement failure was rolled back and the cycle backs off and retries it.
  async function writeOnce({ upserts, removed }) {
    if (phase !== 'open') throw new StoreError('ELOCKLOST', 'the store was lost'); // a backstop: losing it closes the cycle first
    try {
      await inTx(async (c) => {
        for (const kind of Object.keys(removed)) {
          const ids = removed[kind].filter((id) => !data.isSkipped(kind, id));
          for (let i = 0; i < ids.length; i += CHUNK) await c.query(DELETE_SQL, [kind, ids.slice(i, i + CHUNK)]);
        }
        await upsertRows(c, Object.keys(upserts).flatMap((kind) => upserts[kind].map(([id, str]) => [kind, id, str])));
      }, { fence: true });
    } catch (e) {
      const failure = classify(e);
      if (failure.kind === 'fence' || failure.kind === 'connection') connectionLost(failure.err, 'store.lock_lost');
      throw failure.err;
    }
    return true;
  }

  // Gives the lock back and ends the connection. It never rejects, and runs once.
  function release() {
    if (released) return released;
    phase = 'closing';
    released = (async () => {
      const c = client;
      if (c && !ended) { try { await deadline(2000, c.query(UNLOCK_SQL, [LOCK_CLASS]), destroyConn); } catch (e) { /* ending the session releases it anyway */ } }
      if (c && !ended) { try { await deadline(2000, c.end(), destroyConn); } catch (e) { /* nothing left to do */ } }
      destroyConn();
      phase = 'closed';
    })();
    return released;
  }

  const cycle = core.createWriteCycle({ serialiser, sources: data.sources, writeOnce, log, clock, debounceMs });

  // After the write in flight has settled.
  async function close() { await cycle.api.close(); await release(); }
  async function drain() { const ok = await cycle.api.drain(); await release(); return ok; }

  const { lose, ...api } = cycle.api;
  return { ...api, close, drain, kind: 'postgres', load, resetUsage, isSkipped: data.isSkipped, state };
}

module.exports = { createPgStore, StoreError, SCHEMA_VERSION, LOCK_CLASS, STATEMENT_MS, WATCHDOG_SLACK_MS, warnsNoTls, pgError, classify, rowsToDoc };
