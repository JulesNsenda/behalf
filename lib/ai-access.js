'use strict';
// "Use our AI": who may spend the owner's Claude (the built-in proxies, card drafting and the authority audit). Plain values, like
// lib/auth.js: no request, no response. lib/http-auth.js owns the routes; lib/rooms.js asks canUseAi (lib/app.js injects it).
// createAiAccess({ store, config, canRevoke, userInfo, clock, log, notify }) returns:
//  - status(user) -> 'granted' | 'requested' | 'denied' | 'none': an admin (config.adminGithubIds) is always 'granted'. A user is
//    { id, login }, as auth gives it; none or a blocked one is 'none'. A grant that is not durable yet does not count (below).
//  - canUseAi(user), isAdmin(user): booleans. Only status 'granted' grants: any other value, or a damaged record, reads as 'none'
//    (this is not a credential, so a damaged record fails closed).
//  - request(user, note) -> { ok: true, status } | { ok: false, reason: 'note' | 'rate' | 'full' }: the person asks for access. Only
//    'none' and 'requested' change (a repeat updates the note); a granted or denied status is returned as it is, and an admin's, and
//    so is the status while a grant for them is being saved. The note is cleaned text (lib/text.js, at most 280 code points, ''
//    allowed) and is never logged. Its own rate table: 5 per user per 10 minutes. At 500 pending requests a new one is refused
//    ('full'; a repeat by someone already pending still updates). The pending count is kept as requests and decisions come in; it
//    counts a request whose user has since been blocked until an admin decides it. A new request tells `notify` (a no-op until
//    something listens; it must not throw, and a throw is swallowed).
//  - list() -> [{ userId, login, status, note, requestedAt, decidedAt }]: every pending request first, then every grant, then the
//    denied ones, each newest first; a blocked or vanished user is left out. Only the denied rows are capped (500): a request or a
//    grant is never hidden by the cap.
//  - decide(userId, decision, decidedBy) -> Promise<{ ok: true } | { ok: false, reason: 'user' | 'saving' }>: decision is 'grant',
//    'deny' or 'reset' (reset deletes the record); decidedBy is the admin's user id, kept in the record and never logged. 'user': no
//    such user, or blocked. Decisions are strict, like a revocation: while canRevoke() is false nothing is attempted for a grant, and
//    ok is true only once the store confirms. A deny or reset takes effect in memory at once (fail safe: a repeat saves it again).
//    A grant takes effect only once it is durable: until the store confirms, the record is written (the store saves what the map
//    holds) but status() reads the state before it. A grant that cannot be saved is rolled back, but only if the map still holds the
//    record this call wrote, so a deny, reset or request that came in meanwhile is never undone. A second grant for a user whose
//    grant is in flight shares its answer. A confirmed decision logs one event with no fields: `ai.granted`, `ai.denied` or `ai.reset`.
// Record (store collection 'aiaccess', keyed by the user id; a userId inside the doc is ignored): { status, note, requestedAt,
// decidedAt, decidedBy } (ms; decidedAt null until decided, requestedAt null for a grant nobody asked for; decidedBy the deciding
// admin's id, null until decided). The map belongs to this module.
const { cleanText } = require('./text');
const { createPersist } = require('./durable');
const { createRateTable } = require('./rate');

const NOTE_MAX = 280; // code points
const MAX_PENDING = 500;
const MAX_LISTED = 500;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5; // requests per user
const RATE_KEYS = 2000;
const STATUSES = ['requested', 'granted', 'denied'];
const EVENTS = { grant: 'ai.granted', deny: 'ai.denied', reset: 'ai.reset' };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createAiAccess({ store, config, canRevoke, userInfo, clock = {}, log, notify = () => {} }) {
  if (typeof canRevoke !== 'function') throw new TypeError('createAiAccess needs canRevoke');
  if (typeof userInfo !== 'function') throw new TypeError('createAiAccess needs userInfo');
  const now = clock.now || (() => Date.now());
  const records = store.collection('aiaccess');
  const persisted = createPersist({ store, canRevoke });
  const admins = new Set(config.adminGithubIds);
  const granting = new Map(); // user id -> { rec, was, promise }: a grant written but not durable yet (in memory only)
  const pending = new Set(); // the ids whose record is 'requested'

  // The stored status of a user id, or 'none' for no record or a damaged one. A grant in flight reads as the state before it.
  function recorded(userId) {
    const r = records.map.get(userId);
    const flight = granting.get(userId);
    if (flight && flight.rec === r) return flight.was;
    return isObj(r) && STATUSES.includes(r.status) ? r.status : 'none';
  }
  const track = (userId) => { if (recorded(userId) === 'requested') pending.add(userId); else pending.delete(userId); };
  function put(userId, rec) {
    if (rec === undefined) records.map.delete(userId); else records.map.set(userId, rec);
    track(userId);
    records.save(userId);
  }
  for (const userId of records.map.keys()) track(userId);

  const isAdmin = (user) => Boolean(user) && typeof user.id === 'string' && admins.has(user.id);
  function status(user) {
    if (!user || typeof user.id !== 'string') return 'none';
    return isAdmin(user) ? 'granted' : recorded(user.id);
  }
  const canUseAi = (user) => status(user) === 'granted';

  const byUser = createRateTable({ now, windowMs: RATE_WINDOW_MS, cap: RATE_MAX, overflowCap: RATE_MAX * 20, maxKeys: RATE_KEYS, aggregate: () => 'overflow' });

  function request(user, note) {
    const cleaned = note === undefined ? '' : cleanText(note, NOTE_MAX);
    if (cleaned === null) return { ok: false, reason: 'note' };
    const current = status(user);
    if (current === 'granted' || current === 'denied' || granting.has(user.id)) return { ok: true, status: current };
    if (byUser(user.id) !== 'ok') return { ok: false, reason: 'rate' };
    if (current === 'none' && pending.size >= MAX_PENDING) return { ok: false, reason: 'full' };
    const old = records.map.get(user.id);
    const at = now();
    put(user.id, {
      status: 'requested', note: cleaned,
      requestedAt: current === 'requested' && isObj(old) && Number.isFinite(old.requestedAt) ? old.requestedAt : at, decidedAt: null, decidedBy: null,
    });
    if (current === 'none') {
      try { notify(user); } catch (e) { log.error('ai.notify_failed', {}, e); }
    }
    return { ok: true, status: 'requested' };
  }

  function list() {
    const groups = { requested: [], granted: [], denied: [] };
    for (const [userId, r] of records.map) {
      const state = recorded(userId);
      const u = state === 'none' ? null : userInfo(userId);
      if (!u) continue;
      groups[state].push({
        userId, login: u.login, status: state, note: typeof r.note === 'string' ? r.note : '',
        requestedAt: Number.isFinite(r.requestedAt) ? r.requestedAt : null, decidedAt: Number.isFinite(r.decidedAt) ? r.decidedAt : null,
      });
    }
    const when = (e) => e.decidedAt ?? e.requestedAt ?? 0;
    for (const g of Object.values(groups)) g.sort((a, b) => when(b) - when(a));
    return [...groups.requested, ...groups.granted, ...groups.denied.slice(0, MAX_LISTED)];
  }

  // The record a decision writes: the note and the time asked are kept from the record it replaces.
  function decided(state, prior, decidedBy) {
    const p = isObj(prior) ? prior : {};
    return {
      status: state, note: typeof p.note === 'string' ? p.note : '', requestedAt: Number.isFinite(p.requestedAt) ? p.requestedAt : null,
      decidedAt: now(), decidedBy: typeof decidedBy === 'string' ? decidedBy : null,
    };
  }

  const saving = { ok: false, reason: 'saving' };

  // A grant counts only once the store confirms it. The record goes into the map first (the store saves what the map holds) but
  // status() ignores it until then. On a failure it is rolled back, if the map still holds this very record.
  function grant(userId, decidedBy) {
    const live = granting.get(userId);
    if (live && records.map.get(userId) === live.rec) return live.promise;
    if (!canRevoke()) return Promise.resolve(saving);
    const old = records.map.get(userId);
    const flight = { rec: decided('granted', old, decidedBy), was: recorded(userId), promise: null };
    granting.set(userId, flight);
    put(userId, flight.rec);
    flight.promise = (async () => {
      let ok = false;
      try { ok = await persisted('aiaccess', [userId]); } catch { ok = false; }
      const mine = records.map.get(userId) === flight.rec;
      if (granting.get(userId) === flight) granting.delete(userId);
      if (!ok) {
        if (mine) put(userId, old);
        return saving;
      }
      if (!mine) return saving; // a deny, reset or request came in meanwhile and replaced it: the grant was not made
      track(userId);
      log.info(EVENTS.grant, {});
      return { ok: true };
    })();
    return flight.promise;
  }

  async function decide(userId, decision, decidedBy) {
    if (!Object.hasOwn(EVENTS, decision)) throw new TypeError('decide needs grant, deny or reset');
    if (!userInfo(userId)) return { ok: false, reason: 'user' };
    if (decision === 'grant') return grant(userId, decidedBy);
    const old = records.map.get(userId);
    granting.delete(userId); // a grant still being saved is replaced
    put(userId, decision === 'reset' ? undefined : decided('denied', old, decidedBy));
    if (await persisted('aiaccess', [userId])) {
      log.info(EVENTS[decision], {});
      return { ok: true };
    }
    return saving;
  }

  return { status, canUseAi, isAdmin, request, list, decide };
}

module.exports = { createAiAccess, NOTE_MAX, MAX_PENDING, MAX_LISTED };
