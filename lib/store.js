'use strict';
// The room store: rooms.json on disk, the live state in memory.
// On disk: { schemaVersion, rooms: {id: room}, usage, users?, sessions?, agentkeys? }. A file without schemaVersion is version 0.
// users, sessions and agentkeys (id -> plain object) are optional, read as empty when missing and written only when not
// empty, and usage.byUser likewise, so a store with no accounts is byte-compatible with a build that does not know them
// (which ignores them).
// Invariant: state.rooms, state.usage and every collection(kind).map keep their identity for the life of the store. load()
// fills them in place and callers mutate them in place (resetUsage() for the daily reset), so a reference taken once never
// goes stale. The kind table, validation, migrations, serialising and the write cycle live in lib/store-core.js, shared with
// other backends; this file is the file sink: load() and one synchronous temp-file write (writeOnce). The write API (save,
// flush, settle, persist, drain, ...) is documented at createWriteCycle.
// load() never lets a bad file turn into an empty store that the next save() overwrites:
//  - missing file: start empty;
//  - not JSON, or not the right top-level shape: quarantine it to rooms.json.corrupt-<time> (newest 5 kept), start empty;
//  - any other I/O error, a failed quarantine, a file too large to read, or a schemaVersion newer than this code:
//    throw StoreError, write nothing;
//  - a room that fails to migrate or does not have the current shape, or a collection record that is not a plain object (or a
//    collection that is not an object): skip it and log it, load the rest, and keep a copy of the original file as
//    rooms.json.partial-<time> (never pruned: it may be the only copy of a skipped record) first (EPRESERVE if that copy
//    fails). If every room is skipped, throw EALLSKIPPED instead, so a wrong-shaped store is never replaced by an empty one.
//    The file store keeps a skipped record only in that copy; the next write drops it from rooms.json. isSkipped(kind, id)
//    says which ids were skipped, so a new room never takes one.
// StoreError.code is a logger-safe code (EFUTURESCHEMA, EQUARANTINE, ... or the underlying fs code).
const path = require('path');
const crypto = require('crypto');

const core = require('./store-core');
const { SCHEMA_VERSION, StoreError, KIND } = core;

const KEEP_QUARANTINE = 5;
const DEBOUNCE_MS = 300;
const RENAME_TRIES = 5;

const fsCode = (e) => (e && typeof e.code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : 'EIO');

const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no wait, retry at once */ } };
const stamp = () => new Date().toISOString().replace(/:/g, '-');

// clock is optional: { now, setTimeout, clearTimeout }, each defaulting to the real one (tests inject it for the backoff).
function createStore({ file, log, fs = require('fs'), debounceMs = DEBOUNCE_MS, platform = process.platform, clock }) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const data = core.createData();
  const { state } = data;
  let loaded = false;

  function best(fn) { try { fn(); } catch (e) { /* best effort */ } }
  const tighten = (p, mode) => best(() => fs.chmodSync(p, mode));

  function quarantine(reason) {
    const dest = `${file}.corrupt-${stamp()}`;
    try { fs.renameSync(file, dest); } catch (e) { throw new StoreError('EQUARANTINE', 'could not quarantine the store file', e); }
    tighten(dest, 0o600);
    log.error('store.quarantined', {}, new StoreError(reason, 'store file quarantined'));
    prune('.corrupt-', dest);
  }

  // Keeps the newest KEEP_QUARANTINE quarantine copies named <store><kind><time>, counting `mine` (the one just written).
  function prune(kind, mine) {
    best(() => {
      const own = path.basename(mine);
      const old = fs.readdirSync(dir).filter((n) => n.startsWith(base + kind) && n !== own)
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
    if (raw === undefined) { quarantine('EPARSE'); return; }
    const doc = core.parseStoreDoc(raw, log);
    if (doc.error === 'EFUTURESCHEMA') throw new StoreError('EFUTURESCHEMA', 'the store file is from a newer version');
    if (doc.error === 'ESHAPE') { quarantine('ESHAPE'); return; }
    if (doc.error === 'EALLSKIPPED') throw new StoreError('EALLSKIPPED', 'no room in the store file has a usable shape');
    if (doc.partial) {
      const copy = `${file}.partial-${stamp()}`;
      try { fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL); } catch (e) { throw new StoreError('EPRESERVE', 'could not keep a copy of the store file', e); }
      tighten(copy, 0o600);
    }
    core.applyDoc(data, doc);
  }

  // A load that throws leaves the store unloaded, so it may be retried.
  function load() {
    if (loaded) throw new StoreError('ELOADED', 'load() was already called');
    readInto();
    loaded = true;
    cycle.setLoaded();
    return state;
  }

  function resetUsage(day) {
    Object.assign(state.usage, core.emptyUsage(), { day });
    cycle.api.saveUsage();
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

  // The sink's one I/O step: the whole file from the cache plus this pass's upserts, to a temp file, then renamed over. A
  // throw is a failed write (the cycle logs it and marks the records again); the temp file never outlives it.
  function writeOnce({ snapshot }) {
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let fd = null;
    try {
      // Each kind is one top-level key: a singleton holds its record, the rest an object id -> record.
      const sections = Object.entries(KIND)
        .map(([kind, def]) => ({ def, lines: snapshot(kind).map(([id, s]) => (def.singleton ? s : JSON.stringify(id) + ':' + s)) }))
        .filter((s) => s.lines.length > 0 || s.def.always);
      try { fd = fs.openSync(tmp, 'wx', 0o600); } catch (e) {
        // The data directory is made at load; only recreate it if it was removed since.
        if (!e || e.code !== 'ENOENT') throw e;
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fd = fs.openSync(tmp, 'wx', 0o600);
      }
      best(() => fs.fchmodSync(fd, 0o600)); // belt and braces against an inherited mode
      writeAll(fd, `{"schemaVersion":${SCHEMA_VERSION}`);
      for (const { def, lines } of sections) {
        writeAll(fd, `,"${def.key}":` + (def.singleton ? lines[0] : '{'));
        if (def.singleton) continue;
        lines.forEach((p, i) => writeAll(fd, (i ? ',' : '') + p));
        writeAll(fd, '}');
      }
      writeAll(fd, '}');
      fs.fsyncSync(fd);
      const done = fd;
      fd = null;
      fs.closeSync(done);
      renameWithRetry(tmp, file);
      if (platform !== 'win32') best(() => { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } });
      return true;
    } catch (e) {
      if (fd !== null) best(() => fs.closeSync(fd));
      best(() => fs.unlinkSync(tmp));
      throw e;
    }
  }

  const cycle = core.createWriteCycle({
    serialiser: core.createSerialiser(log), sources: data.sources, writeOnce, log, clock, debounceMs, failEvent: 'store.save_failed',
  });

  return { ...cycle.api, kind: 'file', load, resetUsage, isSkipped: data.isSkipped, state };
}

module.exports = { createStore, StoreError, SCHEMA_VERSION };
