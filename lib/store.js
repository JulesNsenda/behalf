'use strict';
// The room store: rooms.json on disk, the live state in memory.
// On disk: { schemaVersion, rooms: {id: room}, usage }. A file without schemaVersion is version 0.
// Invariant: state.rooms and state.usage keep their identity for the life of the store. load() fills them in place and
// callers mutate them in place (resetUsage() for the daily reset), so a reference taken once never goes stale.
// load() never lets a bad file turn into an empty store that the next save() overwrites:
//  - missing file: start empty;
//  - not JSON, or not the right top-level shape: quarantine it to rooms.json.corrupt-<time> (newest 5 kept), start empty;
//  - any other I/O error, a failed quarantine, a file too large to read, or a schemaVersion newer than this code:
//    throw StoreError, write nothing;
//  - a room that fails to migrate or does not have the current shape: skip it and log it, load the rest, and keep a copy
//    of the original file as rooms.json.partial-<time> first (EPRESERVE if that copy fails). If every room is skipped,
//    throw EALLSKIPPED instead, so a wrong-shaped store is never replaced by an empty one.
// StoreError.code is a logger-safe code (EFUTURESCHEMA, EQUARANTINE, ... or the underlying fs code).
// Saving is debounced in a fixed window, rooms are serialised one at a time and cached, and a room that cannot be
// serialised keeps its last good copy. Nothing is written without a call to save() or flush().
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const KEEP_QUARANTINE = 5;
const DEBOUNCE_MS = 300;
const RENAME_TRIES = 5;

class StoreError extends Error {
  constructor(code, msg, cause) { super(msg); this.name = 'StoreError'; this.code = code; if (cause) this.cause = cause; }
}

// A null-prototype map of finite, non-negative numbers: anything else in the stored object is dropped.
function counts(o) {
  const out = Object.create(null);
  if (isObj(o)) for (const [k, n] of Object.entries(o)) if (Number.isFinite(n) && n >= 0) out[k] = n;
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fsCode = (e) => (e && typeof e.code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : 'EIO');

// The current shape, checked after migration.
function validRoom(id, r) {
  return isObj(r) && r.id === id && isObj(r.seats)
    && isObj(r.seats.A) && typeof r.seats.A.token === 'string' && isObj(r.seats.B) && typeof r.seats.B.token === 'string'
    && Array.isArray(r.ledger) && Array.isArray(r.envelopes) && isObj(r.claims);
}

// Each step takes a room from version N to N + 1.
const MIGRATIONS = [
  function v0to1(r) {
    for (const s of ['A', 'B']) if (!r.seats[s].mode) r.seats[s].mode = 'builtin';
    r.demo = r.demo === true;
  },
];
if (MIGRATIONS.length !== SCHEMA_VERSION) throw new Error('lib/store: one migration per schema version');

const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no wait, retry at once */ } };
const stamp = () => new Date().toISOString().replace(/:/g, '-');

function createStore({ file, log, fs = require('fs'), debounceMs = DEBOUNCE_MS, platform = process.platform }) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const state = { rooms: new Map(), usage: { day: '', total: 0, byIp: Object.create(null), failedByIp: Object.create(null) } };
  const cache = new Map(); // id -> last good serialised room
  const dirty = new Set();
  const warned = new Set(); // rooms already logged as unserialisable
  let allDirty = true;
  let timer = null;
  let loaded = false;
  let closed = false;

  function best(fn) { try { fn(); } catch (e) { /* best effort */ } }
  const tighten = (p, mode) => best(() => fs.chmodSync(p, mode));
  function cancel() { clearTimeout(timer); timer = null; }

  function quarantine(reason) {
    const dest = `${file}.corrupt-${stamp()}`;
    try { fs.renameSync(file, dest); } catch (e) { throw new StoreError('EQUARANTINE', 'could not quarantine the store file', e); }
    tighten(dest, 0o600);
    log.error('store.quarantined', {}, new StoreError(reason, 'store file quarantined'));
    best(() => {
      const mine = path.basename(dest);
      const old = fs.readdirSync(dir).filter((n) => n.startsWith(base + '.corrupt-') && n !== mine)
        .map((n) => { let t = 0; try { t = fs.statSync(path.join(dir, n)).mtimeMs; } catch (e) { /* sorts first */ } return { n, t }; })
        .sort((a, b) => a.t - b.t || (a.n < b.n ? -1 : 1));
      for (const o of old.slice(0, Math.max(0, old.length - (KEEP_QUARANTINE - 1)))) best(() => fs.unlinkSync(path.join(dir, o.n)));
    });
  }

  function readInto() {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { throw new StoreError(fsCode(e), 'could not create the data directory', e); }
    tighten(dir, 0o700);
    best(() => { for (const n of fs.readdirSync(dir)) if (n.startsWith(base + '.tmp')) best(() => fs.unlinkSync(path.join(dir, n))); });
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return;
      if (e && (e.code === 'ERR_STRING_TOO_LONG' || e instanceof RangeError)) throw new StoreError('ETOOLARGE', 'the store file is too large to read', e);
      throw new StoreError(fsCode(e), 'could not read the store file', e);
    }
    tighten(file, 0o600);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    let raw;
    try { raw = JSON.parse(text); } catch (e) { raw = undefined; }
    const version = isObj(raw) && raw.schemaVersion !== undefined ? raw.schemaVersion : 0;
    if (typeof version === 'number' && version > SCHEMA_VERSION) throw new StoreError('EFUTURESCHEMA', 'the store file is from a newer version');
    if (raw === undefined) { quarantine('EPARSE'); return; }
    if (!isObj(raw) || !isObj(raw.rooms) || !Number.isInteger(version) || version < 0) { quarantine('ESHAPE'); return; }

    const good = new Map();
    let skipped = 0;
    for (const [id, room] of Object.entries(raw.rooms)) {
      try {
        if (!isObj(room)) throw new Error('not a room');
        for (let v = version; v < SCHEMA_VERSION; v++) MIGRATIONS[v](room);
        if (!validRoom(id, room)) throw new Error('bad shape');
        good.set(id, room);
      } catch (e) {
        skipped++;
        log.error('store.room_skipped', { room: String(id).slice(0, 64) });
      }
    }
    if (skipped > 0) {
      if (good.size === 0) throw new StoreError('EALLSKIPPED', 'no room in the store file has a usable shape');
      const copy = `${file}.partial-${stamp()}`;
      try { fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL); } catch (e) { throw new StoreError('EPRESERVE', 'could not keep a copy of the store file', e); }
      tighten(copy, 0o600);
    }
    for (const [id, room] of good) state.rooms.set(id, room);
    const u = raw.usage;
    if (isObj(u) && typeof u.day === 'string' && Number.isFinite(u.total) && u.total >= 0) {
      state.usage.day = u.day;
      state.usage.total = u.total;
      state.usage.byIp = counts(u.byIp);
      state.usage.failedByIp = counts(u.failedByIp); // an old failedTotal in the file is ignored
    }
  }

  // A load that throws leaves the store unloaded, so it may be retried.
  function load() {
    if (loaded) throw new StoreError('ELOADED', 'load() was already called');
    readInto();
    loaded = true;
    return state;
  }

  function resetUsage(day) {
    state.usage.day = day;
    state.usage.total = 0;
    state.usage.byIp = Object.create(null);
    state.usage.failedByIp = Object.create(null);
  }

  // Only dirty rooms (and rooms not cached yet) are serialised again. A room that throws keeps its last good string.
  function serialise() {
    const all = allDirty;
    allDirty = false;
    const parts = [];
    for (const [id, room] of state.rooms) {
      if (all || dirty.has(id) || !cache.has(id)) {
        try { cache.set(id, JSON.stringify({ ...room, running: undefined })); warned.delete(id); } catch (e) {
          if (!warned.has(id)) { warned.add(id); log.error('store.room_unserialisable', { room: String(id).slice(0, 64) }, e); }
        }
      }
      if (cache.has(id)) parts.push(JSON.stringify(id) + ':' + cache.get(id));
    }
    dirty.clear();
    for (const id of cache.keys()) if (!state.rooms.has(id)) { cache.delete(id); warned.delete(id); }
    return parts;
  }

  // writeSync may write fewer bytes than asked.
  function writeAll(fd, str) {
    const buf = Buffer.from(str);
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw new StoreError('EIO', 'short write');
      off += n;
    }
  }

  function renameWithRetry(from, to) {
    for (let i = 1; ; i++) {
      try { return fs.renameSync(from, to); } catch (e) {
        // Windows: a scanner or another handle can hold the target for a moment.
        if (platform !== 'win32' || i >= RENAME_TRIES || !e || (e.code !== 'EPERM' && e.code !== 'EBUSY')) throw e;
        pause(20 * i);
      }
    }
  }

  // Returns whether the file was written.
  function write() {
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let fd = null;
    try {
      const parts = serialise();
      const usage = JSON.stringify(state.usage);
      try { fd = fs.openSync(tmp, 'wx', 0o600); } catch (e) {
        // The data directory is made at load; only recreate it if it was removed since.
        if (!e || e.code !== 'ENOENT') throw e;
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fd = fs.openSync(tmp, 'wx', 0o600);
      }
      best(() => fs.fchmodSync(fd, 0o600)); // belt and braces against an inherited mode
      writeAll(fd, `{"schemaVersion":${SCHEMA_VERSION},"rooms":{`);
      parts.forEach((p, i) => writeAll(fd, (i ? ',' : '') + p));
      writeAll(fd, `},"usage":${usage}}`);
      fs.fsyncSync(fd);
      const done = fd;
      fd = null;
      fs.closeSync(done);
      renameWithRetry(tmp, file);
      if (platform !== 'win32') best(() => { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } });
      return true;
    } catch (e) {
      log.error('store.save_failed', {}, e);
      if (fd !== null) best(() => fs.closeSync(fd));
      best(() => fs.unlinkSync(tmp));
      return false;
    }
  }

  // Fixed window: a save() while one is pending does not push it back, so steady traffic cannot starve the write.
  function save(id) {
    if (closed) return;
    if (id === undefined) allDirty = true; else dirty.add(id);
    schedule();
  }

  // The usage counters only: schedules a write without marking any room dirty.
  function saveUsage() {
    if (closed) return;
    schedule();
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; write(); }, debounceMs);
    timer.unref();
  }

  // Synchronous; returns whether the write succeeded.
  function flush() {
    cancel();
    return write();
  }

  function close() {
    cancel();
    closed = true;
  }

  return { load, save, saveUsage, flush, close, resetUsage, state };
}

module.exports = { createStore, StoreError, SCHEMA_VERSION };
