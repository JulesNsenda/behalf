'use strict';
// What every store backend shares: the kind table (what a room, the usage and each account collection are), the document
// parser, the per-record serialiser and the write cycle. A sink (lib/store.js, a database sink) supplies only its load and
// one writeOnce(); validation, migrations and the skipped-record policy exist once, here.

const SCHEMA_VERSION = 1;

class StoreError extends Error {
  constructor(code, msg, cause) { super(msg); this.name = 'StoreError'; this.code = code; if (cause) this.cause = cause; }
}

// The Node/OS error code of e when it is a logger-safe E-code, else `dflt`.
const safeCode = (e, dflt = null) => (e && typeof e.code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : dflt);
const best = (fn) => { try { fn(); } catch (e) { /* best effort */ } };
// A record id: 1 to 256 characters, no NUL (a database text value cannot hold one) and no lone surrogate (it cannot be encoded
// as UTF-8 for a text parameter). The surrogate test is a regex literal, not a string: a lone high surrogate not followed by a
// low one, or a lone low one not preceded by a high one.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const validId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 256 && !id.includes(String.fromCharCode(0)) && !LONE_SURROGATE.test(id);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A null-prototype map of finite, non-negative numbers: anything else in the stored object is dropped.
function counts(o) {
  const out = Object.create(null);
  if (isObj(o)) for (const [k, n] of Object.entries(o)) if (Number.isFinite(n) && n >= 0) out[k] = n;
  return out;
}

function emptyUsage() {
  return { day: '', total: 0, byIp: Object.create(null), failedByIp: Object.create(null), byUser: Object.create(null), invitesByUser: Object.create(null), invitesTotal: 0 };
}

// The stored usage to the in-memory shape, or null when it is not usable (the caller keeps its empty usage).
function normaliseUsage(u) {
  if (!(isObj(u) && typeof u.day === 'string' && Number.isFinite(u.total) && u.total >= 0)) return null;
  // An old failedTotal in the file is ignored; a file from before byUser has none.
  // A file from before the invite counters has none.
  const invitesTotal = Number.isFinite(u.invitesTotal) && u.invitesTotal >= 0 ? u.invitesTotal : 0;
  return { day: u.day, total: u.total, byIp: counts(u.byIp), failedByIp: counts(u.failedByIp), byUser: counts(u.byUser), invitesByUser: counts(u.invitesByUser), invitesTotal };
}

// The current shape, checked after migration.
function validRoom(id, r) {
  return isObj(r) && r.id === id && isObj(r.seats)
    && isObj(r.seats.A) && typeof r.seats.A.token === 'string' && isObj(r.seats.B) && typeof r.seats.B.token === 'string'
    && Array.isArray(r.ledger) && Array.isArray(r.envelopes) && isObj(r.claims);
}

// Each step takes a room from version N to N + 1. INVARIANT: every step is idempotent (applying it twice gives the same room
// as once). A store may run the migrations again on rooms that already have the new shape: the Postgres sink does so at every
// boot while a skipped room keeps its meta version from being bumped. A test applies each step twice.
const MIGRATIONS = [
  function v0to1(r) {
    for (const s of ['A', 'B']) if (!r.seats[s].mode) r.seats[s].mode = 'builtin';
    r.demo = r.demo === true;
  },
];
if (MIGRATIONS.length !== SCHEMA_VERSION) throw new Error('lib/store: one migration per schema version');

// A doc becomes a live record, so one with a key that could reach a prototype is refused outright.
const hasProtoKey = (doc) => ['__proto__', 'constructor', 'prototype'].some((k) => Object.prototype.hasOwnProperty.call(doc, k));

const encodeRoom = (room) => JSON.stringify({ ...room, running: undefined }); // `running` is transient
// byUser, invitesByUser and invitesTotal are stored only when they have entries, so a store with no accounts or invites is
// byte-identical to one from before they existed.
const encodeUsage = (u) => {
  const { byUser, invitesByUser, invitesTotal, ...rest } = u;
  const out = { ...rest };
  if (byUser && Object.keys(byUser).length) out.byUser = byUser;
  if (invitesByUser && Object.keys(invitesByUser).length) out.invitesByUser = invitesByUser;
  if (invitesTotal) out.invitesTotal = invitesTotal;
  return JSON.stringify(out);
};
const encodeDoc = (doc) => JSON.stringify(doc);

// Migrates one stored room from `version` in place and checks its shape.
function loadRoom(id, room, version) {
  if (!isObj(room)) return false;
  for (let v = version; v < SCHEMA_VERSION; v++) MIGRATIONS[v](room);
  return validRoom(id, room);
}
const loadAccountDoc = (id, doc) => isObj(doc) && !hasProtoKey(doc);

// The one table of record kinds. key: the top-level key in a stored document. encode: a record to its JSON text. load: whether a
// stored record is usable (it may migrate it in place); for a singleton, the stored value to its in-memory form or null.
// singleton: the id of the one record (the usage). logId: a skipped or unserialisable record is logged with its id, as
// `room`; every other kind is logged without one. allSkippedFatal: if records of this kind were stored and none is usable,
// the document is refused, so an empty store never replaces it. always: written even when empty; the rest only when not.
const KIND = Object.freeze({
  room: Object.freeze({ key: 'rooms', encode: encodeRoom, load: loadRoom, logId: true, allSkippedFatal: true, always: true }),
  usage: Object.freeze({ key: 'usage', encode: encodeUsage, load: normaliseUsage, singleton: 'today' }),
  user: Object.freeze({ key: 'users', encode: encodeDoc, load: loadAccountDoc }),
  session: Object.freeze({ key: 'sessions', encode: encodeDoc, load: loadAccountDoc }),
  agentkey: Object.freeze({ key: 'agentkeys', encode: encodeDoc, load: loadAccountDoc }),
  aiaccess: Object.freeze({ key: 'aiaccess', encode: encodeDoc, load: loadAccountDoc }), // "Use our AI" access, by user id
});
const ALL = Object.keys(KIND);
const KINDS = Object.freeze(ALL.filter((k) => !KIND[k].always && !KIND[k].singleton)); // the account collections

// The usage object as a one-record source, read live so the object itself may be replaced.
const liveSingleton = (id, get) => ({ has: (k) => k === id, keys: () => [id][Symbol.iterator](), *[Symbol.iterator]() { yield [id, get()]; } });

// The in-memory data of a store, shared by every sink: state { rooms, usage }, maps (room and each collection, by kind),
// sources (what the write cycle serialises: maps plus the usage), and the ids skipped at load, by kind.
function createData() {
  const state = { rooms: new Map(), usage: emptyUsage() };
  const maps = {};
  const sources = {};
  const skipped = {};
  for (const kind of ALL) {
    const def = KIND[kind];
    if (def.singleton) { sources[kind] = liveSingleton(def.singleton, () => state[def.key]); continue; }
    maps[kind] = state[def.key] || new Map(); // the rooms map is state.rooms; a collection has no other home
    sources[kind] = maps[kind];
    skipped[kind] = new Set();
  }
  return { state, maps, sources, skipped, isSkipped: (kind, id) => Boolean(skipped[kind] && skipped[kind].has(id)) };
}

const skipLine = (log, def, id) => {
  if (log) log.error(def.logId ? 'store.room_skipped' : 'store.record_skipped', def.logId ? { room: String(id).slice(0, 64) } : {});
};

// A parsed store document (no I/O; it migrates rooms in place) to { version, records: {kind: [[id, doc]]}, skipped: {kind: [id]},
// partial }, or { error } when the document as a whole is unusable: ESHAPE (wrong top level), EFUTURESCHEMA (newer than this
// code), EALLSKIPPED (see KIND). partial: something was skipped, or a collection was present but not an object, so the caller
// should keep a copy of the original. A file without schemaVersion is version 0. `log` is optional and gets the skip lines.
// options.allSkippedFatal (default true): whether a kind whose records are all unusable refuses the document (see KIND). A sink
// that keeps its rows (a database) passes false: its stored rows are never replaced by an empty store.
function parseStoreDoc(raw, log, { allSkippedFatal = true } = {}) {
  const version = isObj(raw) && raw.schemaVersion !== undefined ? raw.schemaVersion : 0;
  if (typeof version === 'number' && version > SCHEMA_VERSION) return { error: 'EFUTURESCHEMA' };
  if (!isObj(raw) || !isObj(raw[KIND.room.key]) || !Number.isInteger(version) || version < 0) return { error: 'ESHAPE' };
  const records = {};
  const skipped = {};
  let partial = false;
  for (const kind of ALL) {
    const def = KIND[kind];
    const stored = raw[def.key];
    if (def.singleton) { const u = def.load(stored); records[kind] = u ? [[def.singleton, u]] : []; continue; }
    records[kind] = [];
    skipped[kind] = [];
    if (stored !== undefined && !isObj(stored)) { partial = true; skipLine(log, def); continue; }
    for (const [id, doc] of Object.entries(stored || {})) {
      let ok = false;
      try { ok = def.load(id, doc, version); } catch (e) { /* a migration that throws skips the record */ }
      if (ok) records[kind].push([id, doc]); else { skipped[kind].push(id); partial = true; skipLine(log, def, id); }
    }
    if (allSkippedFatal && def.allSkippedFatal && skipped[kind].length > 0 && records[kind].length === 0) return { error: 'EALLSKIPPED' };
  }
  return { version, records, skipped, partial };
}

// The daily reset of the usage: empty counters under the new day, saved through the sink's write api.
function resetUsage(data, api, day) {
  Object.assign(data.state.usage, emptyUsage(), { day });
  api.saveUsage();
}

// A stored-document text (the file store's, or an import's) to what parseStoreDoc returns, or { error: 'EPARSE' } when it is not
// JSON. A leading BOM is ignored.
function decodeStoreText(text, log) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { error: 'EPARSE' }; }
  return parseStoreDoc(raw, log);
}

// The timestamp in a file name, and the name a store file is set aside under when it cannot be used.
const stamp = (ms) => new Date(ms).toISOString().replace(/:/g, '-');
const corruptPath = (file, ms) => `${file}.corrupt-${stamp(ms)}`;

// Fills a createData() result from a parseStoreDoc() result, in place: the maps and the usage keep their identity.
function applyDoc(data, doc) {
  for (const kind of Object.keys(data.maps)) {
    for (const [id, rec] of doc.records[kind]) data.maps[kind].set(id, rec);
    for (const id of doc.skipped[kind]) data.skipped[kind].add(id);
  }
  for (const [, usage] of doc.records.usage) Object.assign(data.state.usage, usage);
}

// Per-(kind, id) serialising, in steps so a failed write loses nothing.
//  - pass(kind, map, { all, dirty }) serialises the dirty records (all of them when `all`, and any not cached yet) and returns
//    { upserts: [[id, string]], removed: [id], failed: [id] }. removed is the dirty string ids absent from `map` plus cached
//    ids no longer in it. A record that throws is in `failed` and keeps its last good string; it is logged once. A non-string
//    id would write invalid JSON, so it is skipped and logged as store.record_bad_id. pass() changes no cache.
//  - commit(kind, result) applies a pass to the cache; call it once the write succeeded.
//  - snapshot(kind, map, result) is every record to write as [id, string] (cache plus upserts), in map order.
function createSerialiser(log, kinds = ALL) {
  const cache = Object.fromEntries(kinds.map((k) => [k, new Map()])); // kind -> id -> last good string
  const warned = Object.fromEntries(kinds.map((k) => [k, new Set()])); // kind -> ids already logged
  const once = (kind, id, fn) => { if (!warned[kind].has(id)) { warned[kind].add(id); fn(); } };

  function pass(kind, map, { all = false, dirty } = {}) {
    const def = KIND[kind];
    const c = cache[kind];
    const upserts = [];
    const removed = new Set();
    const failed = [];
    for (const [id, doc] of map) {
      if (!validId(id)) { failed.push(id); once(kind, id, () => log.error('store.record_bad_id', {})); continue; }
      if (!(all || (dirty && dirty.has(id)) || !c.has(id))) continue;
      try {
        const str = def.encode(doc);
        warned[kind].delete(id);
        if (c.get(id) !== str) upserts.push([id, str]); // what the backend already holds is not written again
      } catch (e) {
        failed.push(id);
        once(kind, id, () => log.error(def.logId ? 'store.room_unserialisable' : 'store.record_unserialisable', def.logId ? { room: String(id).slice(0, 64) } : {}, e));
      }
    }
    if (dirty) for (const id of dirty) if (validId(id) && !map.has(id)) removed.add(id);
    for (const id of c.keys()) if (!map.has(id)) removed.add(id);
    return { upserts, removed: [...removed], failed };
  }

  function commit(kind, result) {
    for (const [id, str] of result.upserts) cache[kind].set(id, str);
    for (const id of result.removed) { cache[kind].delete(id); warned[kind].delete(id); }
  }

  function snapshot(kind, map, result) {
    const fresh = new Map(result.upserts);
    const out = [];
    for (const id of map.keys()) {
      if (!validId(id)) continue;
      if (fresh.has(id)) out.push([id, fresh.get(id)]); else if (cache[kind].has(id)) out.push([id, cache[kind].get(id)]);
    }
    return out;
  }

  // The text the backend already holds for a record it loaded, so the first write carries only what changed since.
  function seed(kind, id, str) { cache[kind].set(id, str); }

  return { pass, commit, snapshot, seed };
}

const BACKOFF_CAP_MS = 30000;
const MIN_BACKOFF_MS = 100;
const MAX_LAPS = 50;
const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; }, clearTimeout: (t) => clearTimeout(t) };

// The write side of a sink. `sources` is { kind: map-like } (see createData). Returns { api, setLoaded }: api is the public
// write surface a sink spreads into its store, setLoaded() opens the cycle once the sink has loaded. The cycle owns:
//  - the marks, per kind: an id, or the whole kind. Every kind starts all-dirty so the first write after load rewrites
//    everything (the restart corrections reach the backend). A singleton kind (the usage) is rewritten on every pass, marked
//    or not, so an unmarked in-place change to it still reaches the backend with the next write;
//  - the lifecycle (unloaded, open, closed): nothing is written before setLoaded() or after close();
//  - a debounce in a fixed window (a mark while one is pending does not push it back);
//  - single flight: at most one writeOnce runs at a time. A mark during a write arms the timer for after it, and settle()
//    awaits the write in flight and then runs passes while marks remain. A pass with nothing marked, while not failing and
//    not forced, writes nothing and counts as durable (flush() on a healthy idle store is true);
//  - taking the marks before a pass and putting them back if it fails; the serialiser's cache is committed only after
//    writeOnce returned true;
//  - lastFailed (ids that could not be serialised in the last good pass, for persist) and health();
//  - retry with exponential backoff: a base of at least MIN_BACKOFF_MS (so a debounce of 0 cannot make a hot loop) doubling to 30 s,
//    reset by a success. A mark during the backoff only marks:
//    the next timed attempt is at max(debounce, backoffUntil); flush(), settle() and persist() do not wait for it. The
//    failure is logged for the first failure of a streak, then at most once per BACKOFF_CAP_MS, so a retry loop or
//    repeated settle() calls never log on every attempt;
//  - drainMarks gives up (false) after MAX_LAPS passes, a backstop against marks that keep arriving.
// writeOnce({ upserts, removed, snapshot }) is the backend's only I/O: upserts and removed are { kind: [...] } of this pass and
// snapshot(kind) is every record of that kind as [id, string]. It returns a boolean or a Promise of one; a throw or a
// rejection is a failure, logged under failEvent.
// api: save(id) (a room), saveUsage(), collection(kind) -> { map, save(id) }, flush() (runs a pass at once; synchronous
// when writeOnce is), settle() (writes what is marked and resolves to whether that worked), persist(kind, id) (true only
// when that record is durable; false on a failed write, a closed store or a record that could not be serialised; an unknown
// kind throws), drain() (settle, then close: the terminal call), close(), lose(at) (close, and stay not ok from `at`), health() -> { ok, failingSince }.
function createWriteCycle({ serialiser, sources, writeOnce, log, clock = {}, debounceMs, failEvent = 'store.write_failed' }) {
  const clk = { ...realClock, ...clock };
  const kinds = Object.keys(sources);
  const dirty = Object.fromEntries(kinds.map((k) => [k, new Set()]));
  const allDirty = Object.fromEntries(kinds.map((k) => [k, true]));
  let lastFailed = Object.fromEntries(kinds.map((k) => [k, new Set()]));
  let phase = 'unloaded';
  let timer = null;
  let inflight = null;
  let failures = 0;
  let backoffUntil = 0;
  let nextLogAt = 0; // a failure is logged once the clock reaches this
  let failingSince = null;
  let lostAt = null; // set by lose(): the store is gone for good, and failingSince can never be cleared by a late success

  const hasMarks = () => kinds.some((k) => allDirty[k] || dirty[k].size > 0);
  const cancel = () => { if (timer !== null) clk.clearTimeout(timer); timer = null; };
  const rewritten = kinds.filter((k) => KIND[k].singleton); // rewritten on every pass
  // A programmer error: a kind the cycle does not have, or a singleton marked with an id that is not its own.
  const known = (kind, id) => {
    if (!Object.hasOwn(sources, kind)) throw new Error('unknown collection kind');
    if (id !== undefined && !validId(id)) throw new Error('invalid record id');
    if (KIND[kind].singleton && id !== undefined && id !== KIND[kind].singleton) throw new Error('unknown record of a singleton kind');
  };

  function arm() {
    if (timer !== null || phase === 'closed') return;
    timer = clk.setTimeout(() => {
      timer = null;
      if (inflight) return;
      // Nothing here may escape: a sync throw would be uncaught, a rejection unhandled.
      try { const r = start(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) { /* the next mark or settle retries */ }
    }, Math.max(debounceMs, backoffUntil - clk.now()));
  }

  function mark(kind, id) {
    known(kind, id);
    if (phase === 'closed') return;
    if (id === undefined) allDirty[kind] = true; else dirty[kind].add(id);
    arm();
  }

  // The end of a pass: commit it or put its marks back, then arm a timer (honouring the backoff) for the marks that remain (set
  // during the write, or by a failure) and, after a failure, for the retry even if the pass took no marks: a recovered sink
  // then clears the failure without waiting for an unrelated mark. A logger that throws cannot break the cycle.
  function finish(taken, results, ok, err) {
    try {
      if (ok) {
        lastFailed = {};
        for (const k of kinds) { serialiser.commit(k, results[k]); lastFailed[k] = new Set(results[k].failed); }
        failures = 0; backoffUntil = 0; nextLogAt = 0; failingSince = null;
      } else {
        for (const k of kinds) { if (taken.all[k]) allDirty[k] = true; for (const id of taken.ids[k]) dirty[k].add(id); }
        const now = clk.now();
        const step = Math.min(BACKOFF_CAP_MS, Math.max(debounceMs, MIN_BACKOFF_MS) * 2 ** failures);
        failures++;
        backoffUntil = now + step;
        if (failingSince === null) failingSince = now;
        if (now >= nextLogAt && lostAt === null) { // a lost store has already reported itself
          nextLogAt = now + BACKOFF_CAP_MS;
          try { log.error(failEvent, {}, err); } catch (e) { /* logging must not break the cycle */ }
        }
      }
    } finally {
      if (!ok || hasMarks()) arm();
    }
    return ok;
  }

  // One pass: null when it did not run (not open), else true or false, or a Promise of one when writeOnce is async. Callers
  // check `inflight` first. It cancels the timer, so one armed while a pass was in flight cannot fire a stray pass after
  // this one took its marks. With nothing marked, not forced and not failing there is nothing to write: true, no writeOnce.
  function start(force) {
    if (phase !== 'open') return null;
    cancel();
    if (!force && !hasMarks() && failingSince === null) return true;
    const taken = { all: { ...allDirty }, ids: Object.fromEntries(kinds.map((k) => [k, new Set(dirty[k])])) };
    for (const k of rewritten) taken.all[k] = true;
    for (const k of kinds) { allDirty[k] = false; dirty[k].clear(); }
    const results = {};
    let res;
    try {
      for (const k of kinds) results[k] = serialiser.pass(k, sources[k], { all: taken.all[k], dirty: taken.ids[k] });
      res = writeOnce({
        upserts: Object.fromEntries(kinds.map((k) => [k, results[k].upserts])),
        removed: Object.fromEntries(kinds.map((k) => [k, results[k].removed])),
        snapshot: (k) => serialiser.snapshot(k, sources[k], results[k]),
      });
    } catch (e) { return finish(taken, results, false, e); }
    if (res && typeof res.then === 'function') {
      inflight = Promise.resolve(res).then(
        (ok) => { inflight = null; return finish(taken, results, ok === true); },
        (e) => { inflight = null; return finish(taken, results, false, e); },
      );
      return inflight;
    }
    return finish(taken, results, res === true);
  }

  // Runs passes until no marks remain, and resolves to the result of its own last pass. One failed pass ends it, so it never
  // spins on a failure. `force` writes even with no marks (a persist with no id).
  async function drainMarks(force) {
    cancel();
    let last = null; // the result of this call's last pass
    for (let laps = 0; ; laps++) {
      if (laps >= MAX_LAPS) return false;
      if (phase === 'unloaded') return false;
      // Closed during the drain: start() refuses and leaves the marks, so another lap would spin. Durable only if nothing is left.
      if (phase === 'closed') return last === true && !hasMarks();
      if (inflight) { await inflight; if (phase === 'closed') return false; continue; }
      if (last === false || !(hasMarks() || (force && last === null))) break;
      const r = start(force && last === null);
      last = r !== null && typeof r.then === 'function' ? await r : r;
    }
    return last === null ? failingSince === null : last;
  }

  async function drain() {
    const ok = await drainMarks(false);
    await close();
    return ok;
  }

  function close() { cancel(); phase = 'closed'; return Promise.resolve(inflight).then(() => undefined); }
  // The backend is lost for good: close, and keep health not ok from `at` on (the earlier of that and any write failure).
  function lose(at) { if (lostAt === null) lostAt = at; return close(); }
  function health() {
    const f = lostAt === null ? failingSince : (failingSince === null ? lostAt : Math.min(failingSince, lostAt));
    return { ok: f === null, failingSince: f };
  }

  const api = {
    save: (id) => mark('room', id),
    saveUsage: () => mark('usage', KIND.usage.singleton),
    collection(kind) {
      if (!Object.hasOwn(sources, kind) || KIND[kind].singleton) throw new Error('unknown collection kind');
      return { map: sources[kind], save: (id) => mark(kind, id) };
    },
    // Synchronous with a synchronous writeOnce; false when a write is in flight (it cannot be waited for here), not open, or closed.
    flush() { cancel(); if (inflight) return false; const r = start(); return r === null ? false : r; },
    settle: () => drainMarks(false),
    persist(kind, id) {
      known(kind, id);
      if (phase === 'closed') return Promise.resolve(false);
      if (id !== undefined) dirty[kind].add(id); // with an id there is a mark until some pass takes it: no forced pass
      return drainMarks(id === undefined).then((ok) => ok && !lastFailed[kind].has(id));
    },
    drain,
    close,
    lose,
    health,
  };

  return { api, setLoaded() { if (phase === 'unloaded') phase = 'open'; } };
}

module.exports = { SCHEMA_VERSION, MIGRATIONS, StoreError, safeCode, best, validId, resetUsage, decodeStoreText, stamp, corruptPath, KIND, KINDS, emptyUsage, createData, parseStoreDoc, applyDoc, createSerialiser, createWriteCycle };
