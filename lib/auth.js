'use strict';
// GitHub sign-in and the accounts behind it, on plain values: no request, no response, no cookie. lib/http.js owns the cookies
// and the routes. createAuth({ store, config, secrets, canRevoke, fetch, clock, log, random }) returns:
//  - beginLogin(next) -> { state, verifier, next, location }: the OAuth redirect (PKCE S256, no scope) and what to remember for
//    the callback. next is one of three paths, else '/'.
//  - completeLogin({ code, state, expected, previousToken, ip }) -> { token, user: { login }, next }: the callback. expected is what
//    beginLogin returned, as it came back in the cookie. A state works once. The GitHub token is used for one profile read and
//    dropped; GitHub is never followed through a redirect. previousToken is the session the request already had, which is ended.
//    Every failure is an AuthError (a fixed code, never text from GitHub). Once the state has matched, the attempt counts against
//    the address: at most 20 per address (IPv6: its /64) in 10 minutes, from a capped table; addresses past the cap share an
//    overflow bucket (per /48 for IPv6, per /24 for IPv4). AUTH_RATE is logged once per bucket and window. A bare or forged
//    callback never reaches the limiter.
//  - userRateOk(userId): whether a user may mint another key (10 per 10 minutes). Logout and revoke are never limited.
//  - userForSession(token), userForAgentKey(key) -> { id, login } | null: one Map.get each. A record that is damaged, expired or
//    whose user is gone or blocked counts as absent. A session is deleted when it expires; an agent key after 90 days unused.
//  - userInfo(userId) -> { id, login } | null: a user by id (lib/ai-access.js); absent or blocked is null.
//  - logout(token), mintAgentKey(user, name), revokeAgentKey(user, kid): the change is made in memory at once, and the answer only
//    reports whether it is durable (logout and revoke: true or false; mint: { ok: true, key, kid, name, createdAt }, or a refusal
//    { ok: false, reason: 'name' | 'name_taken' | 'limit' | 'saving' }). checkMint(user, name) is the pure part of mint's checks
//    (the same refusals, no key made and nothing changed): the route asks it first, so a refused request costs no rate allowance
//    and no store check. Revocations are deliberately strict: while canRevoke() is false they refuse at once, with no
//    grace (room creation, by contrast, gets a minute). A repeat of a removal that the store has not confirmed waits for it
//    again; a repeat that names nothing costs no I/O. A failed mint removes only the new key. A user holds several keys
//    (MAX_KEYS_PER_USER live ones), each independent: minting replaces none and a revoke ends one, named by its kid.
//    agentKeysInfo(user) -> [{ kid, name, createdAt, lastUsedAt }], newest first, live keys only. A name is unique among a user's
//    live keys, case-insensitively; an empty one never clashes. sweep(): drops expired sessions,
//    idle keys, and the sessions and keys of blocked users.
// Records (the store's account collections): user { id, login, createdAt, lastLoginAt } by GitHub id; session { userId, createdAt,
// expiresAt, lastSeenAt } and agentkey { userId, name, createdAt, lastUsedAt } by the sha256 of the token, which is never kept.
// Times are ms; name is cleaned text (lib/text.js) or null, lastUsedAt null until first use (a record from before names has no
// own `name` and a lastUsedAt equal to createdAt until used: it reads as not yet used; at load a user's several such records are
// cut to the newest, since the old replace could leave a leaked key behind). lastUsedAt is kept in memory on every use and saved on
// the first use and then at most daily (the time of the last save is kept in memory only). A key's kid (first 12 hex of
// sha256('kid:' + id)) is derived for every key and never stored. One in-memory index (user -> the Set of its key ids), kept only
// by putKey and dropKey, makes the per-user key questions a scan of at most MAX_KEYS_PER_USER entries. The maps belong to this
// module: a change made to them from outside is not seen.
const crypto = require('crypto');
const { AuthError } = require('./errors');
const { safeEqual } = require('./view');
const { rateKey } = require('./net');
const { cleanText } = require('./text');
const { createDurable } = require('./durable');
const { createRateTable } = require('./rate');

const NEXT_PATHS = ['/', '/start', '/connect', '/key', '/admin'];
const GITHUB_TIMEOUT_MS = 10000;
const SESSION_IDLE_MS = 7 * 24 * 3600 * 1000;
const SESSION_MAX_MS = 30 * 24 * 3600 * 1000;
const SEEN_SAVE_MS = 3600 * 1000; // lastSeenAt is saved at most this often
const KEY_IDLE_MS = 90 * 24 * 3600 * 1000; // an agent key not used for this long stops working
const KEY_SEEN_SAVE_MS = 24 * 3600 * 1000; // lastUsedAt is saved at most this often
const MAX_SESSIONS = 10; // per user: the oldest is dropped
const MAX_KEYS_PER_USER = 10; // live agent keys; an idle one is dropped before counting
const KEY_NAME_MAX = 40; // code points
const KID = /^[0-9a-f]{12}$/; // an agent key's public id
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 20; // callbacks per address
const RATE_MAX_KEYS = 500;
const RATE_MAX_OVERFLOW = 200; // callbacks per overflow bucket
const USER_RATE_MAX = 10; // mints per user
const USER_RATE_KEYS = 2000;
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_USED_STATES = 2000;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/; // a GitHub user name

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const kidOf = (id) => sha256('kid:' + id).slice(0, 12); // an agent key's public id: derived, never stored, unrelated to the key
const has = (o, p) => Object.prototype.hasOwnProperty.call(o, p);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (s) => typeof s === 'string' && s.length > 0 && s.length <= 512;
const safeNext = (next) => (NEXT_PATHS.includes(next) ? next : '/');

// canRevoke(): whether a change that must not be lost (a logout, a revoke, a mint) may be attempted now: false while the store is
// failing, with no grace (lib/app.js owns the policy).
function createAuth({ store, config, secrets, canRevoke, fetch = globalThis.fetch, clock = {}, log, random = crypto.randomBytes }) {
  if (typeof canRevoke !== 'function') throw new TypeError('createAuth needs canRevoke');
  const now = clock.now || (() => Date.now());
  const users = store.collection('user');
  const sessions = store.collection('session');
  const agentKeys = store.collection('agentkey');
  const redirectUri = `${config.publicUrl}/auth/github/callback`;
  const blocked = new Set(config.githubBlockedIds);
  const token32 = () => random(32).toString('base64url');

  // ---------- records and their indexes ----------
  // A record that names its owner. A usable session or key has more (below): a damaged one (a hand-edited file or a half-written row)
  // counts as absent.
  const owned = (r) => isObj(r) && typeof r.userId === 'string';
  const sessionDoc = (s) => owned(s) && Number.isFinite(s.expiresAt) && Number.isFinite(s.lastSeenAt);
  const lastUsed = (k) => (Number.isFinite(k.lastUsedAt) ? k.lastUsedAt : k.createdAt); // a key from before lastUsedAt counts from its creation
  const keyIdle = (k, at) => at - lastUsed(k) >= KEY_IDLE_MS;
  // Never used: no lastUsedAt, or (a record from before names, which started it at createdAt) still the creation time.
  const neverUsed = (k) => !Number.isFinite(k.lastUsedAt) || (!has(k, 'name') && k.lastUsedAt === k.createdAt);
  const keyDoc = (k) => owned(k) && Number.isFinite(k.createdAt);
  const isBlocked = (userId) => blocked.has(userId);
  // A user that exists and is not blocked: a blocked id is blocked everywhere, for sessions and keys made before it was.
  const userDoc = (userId) => {
    const u = users.map.get(userId);
    return isObj(u) && typeof u.login === 'string' && !isBlocked(userId) ? { id: userId, login: u.login } : null;
  };

  const dropSession = (id) => { sessions.map.delete(id); sessions.save(id); };

  // The one place a key enters, and (with dropKey) the one place it leaves: keyByUser (userId -> the Set of the ids of its agent
  // keys) is kept only here. A key loaded from the store is put without a mark. A key's public id, its kid, is derived from its
  // id and never stored; it is found only by scanning the user's own Set (at most MAX_KEYS_PER_USER entries), never globally.
  const keyByUser = new Map();
  const lastSaved = new Map(); // key id -> when lastUsedAt was last saved; in memory only
  function putKey(id, doc, mark = true) {
    agentKeys.map.set(id, doc);
    if (!keyByUser.has(doc.userId)) keyByUser.set(doc.userId, new Set());
    keyByUser.get(doc.userId).add(id);
    if (mark) agentKeys.save(id);
  }
  function dropKey(id) {
    const k = agentKeys.map.get(id);
    agentKeys.map.delete(id);
    agentKeys.save(id);
    lastSaved.delete(id);
    const mine = owned(k) ? keyByUser.get(k.userId) : undefined;
    if (mine) { mine.delete(id); if (!mine.size) keyByUser.delete(k.userId); }
  }

  // The user's live keys (usable and not idle) at `at`; with { drop } the others are dropped on the way.
  function liveKeyIds(userId, at, { drop = false } = {}) {
    const live = [];
    for (const id of [...(keyByUser.get(userId) || [])]) {
      const k = agentKeys.map.get(id);
      if (keyDoc(k) && !keyIdle(k, at)) live.push(id);
      else if (drop) dropKey(id);
    }
    return live;
  }

  // The index from what the store loaded. A record with no own `name` is from before names: a user with several keeps the newest.
  // A record with a name (or null) is never cut.
  const newest = new Map(); // userId -> [id, doc] of the newest nameless key so far
  for (const [id, k] of [...agentKeys.map]) {
    if (!keyDoc(k)) continue;
    if (has(k, 'name')) { putKey(id, k, false); continue; }
    const have = newest.get(k.userId);
    if (!have) newest.set(k.userId, [id, k]);
    else if (k.createdAt > have[1].createdAt) { dropKey(have[0]); newest.set(k.userId, [id, k]); } else dropKey(id);
  }
  for (const [id, k] of newest.values()) putKey(id, k, false);

  // ---------- login ----------
  function beginLogin(next) {
    const state = token32();
    const verifier = token32(); // 43 characters, inside PKCE's 43 to 128
    const challenge = crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');
    const params = new URLSearchParams({
      client_id: secrets.githubClientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    return { state, verifier, next: safeNext(next), location: `https://github.com/login/oauth/authorize?${params}` };
  }

  // One GitHub call to its parsed JSON body. A network error, a timeout, a redirect, a status that is not 2xx and a body that is
  // not JSON are all the same failure; nothing from the response is kept.
  async function github(url, init, code) {
    let res;
    try { res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) }); } catch { throw new AuthError(code); }
    if (!res || res.ok !== true) throw new AuthError(code);
    try { return await res.json(); } catch { throw new AuthError(code); }
  }

  async function profileFor(code, verifier) {
    // GitHub answers 200 with { error } when the code is bad, so the body is what decides.
    const tok = await github('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'behalf' },
      body: JSON.stringify({ client_id: secrets.githubClientId, client_secret: secrets.githubClientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }),
    }, 'AUTH_EXCHANGE');
    if (!isObj(tok) || typeof tok.access_token !== 'string' || !tok.access_token || tok.token_type !== 'bearer') throw new AuthError('AUTH_EXCHANGE');
    const me = await github('https://api.github.com/user', {
      headers: { authorization: `Bearer ${tok.access_token}`, 'user-agent': 'behalf', accept: 'application/vnd.github+json' },
    }, 'AUTH_PROFILE');
    // The GitHub token goes out of scope here: it was used once and is never stored or logged.
    if (!isObj(me) || !Number.isSafeInteger(me.id) || me.id < 1 || typeof me.login !== 'string' || !LOGIN.test(me.login)) throw new AuthError('AUTH_PROFILE');
    return { id: String(me.id), login: me.login };
  }

  function upsertUser({ id, login }, at) {
    const old = users.map.get(id);
    users.map.set(id, { id, login, createdAt: isObj(old) && Number.isFinite(old.createdAt) ? old.createdAt : at, lastLoginAt: at });
    users.save(id);
  }

  // The user's sessions beyond `keep`, oldest first, are ended.
  function trimSessions(userId, keep) {
    const mine = []; // a scan: it runs at a login, which the callback limiter bounds
    for (const [id, s] of sessions.map) if (owned(s) && s.userId === userId) mine.push([id, s]);
    mine.sort((a, b) => (Number(a[1].createdAt) || 0) - (Number(b[1].createdAt) || 0));
    for (const [id] of mine.slice(0, Math.max(0, mine.length - keep))) dropSession(id);
  }

  // The states that have been used, by hash, for as long as a login could still be under way. A state works once.
  const usedStates = new Map();
  function takeState(state) {
    const at = now();
    const h = sha256(state);
    const until = usedStates.get(h);
    if (until !== undefined && until > at) return false;
    if (usedStates.size >= MAX_USED_STATES) {
      for (const [k, v] of usedStates) if (v <= at) usedStates.delete(k);
      if (usedStates.size >= MAX_USED_STATES) usedStates.delete(usedStates.keys().next().value); // the oldest
    }
    usedStates.set(h, at + STATE_TTL_MS);
    return true;
  }

  async function login({ code, state, expected, previousToken, ip }) {
    // safeEqual compares digests, so a state of another length can neither throw nor match. Two empty values are not a match.
    if (!isObj(expected) || !text(state) || !text(expected.state) || !text(expected.verifier) || !safeEqual(state, expected.state)) throw new AuthError('AUTH_STATE');
    checkRate(ip); // only a callback that holds a state it was given counts: a bare or forged one never touches the limiter
    if (!takeState(state)) throw new AuthError('AUTH_STATE');
    if (!text(code)) throw new AuthError('AUTH_EXCHANGE');
    const profile = await profileFor(code, expected.verifier);
    if (isBlocked(profile.id)) throw new AuthError('AUTH_BLOCKED');
    const at = now();
    upsertUser(profile, at);
    if (typeof previousToken === 'string' && previousToken && previousToken.length <= 256) dropSession(sha256(previousToken)); // a new login ends the old session
    const token = token32();
    const id = sha256(token);
    trimSessions(profile.id, MAX_SESSIONS - 1);
    sessions.map.set(id, { userId: profile.id, createdAt: at, expiresAt: at + SESSION_MAX_MS, lastSeenAt: at });
    sessions.save(id);
    return { token, user: { login: profile.login }, next: safeNext(expected.next) };
  }

  async function completeLogin(args) {
    try {
      const out = await login(args || {});
      log.info('auth.login', {});
      return out;
    } catch (e) {
      if (e instanceof AuthError && e.code !== 'AUTH_RATE') log.error('auth.login_failed', {}, e); // checkRate logs its own, once per window
      throw e;
    }
  }

  // ---------- rate limits ----------
  const byIp = createRateTable({
    now, windowMs: RATE_WINDOW_MS, cap: RATE_MAX, overflowCap: RATE_MAX_OVERFLOW, maxKeys: RATE_MAX_KEYS,
    // an IPv6 key is four hextets: past the cap its /48 (three) is the bucket; IPv4 and the rest share one
    aggregate: (key) => (key.includes(':') ? 'v6:' + key.split(':').slice(0, 3).join(':') : (key.includes('.') ? 'v4:' + key.split('.').slice(0, 3).join('.') : 'overflow')),
  });
  function checkRate(ip) {
    const r = byIp(rateKey(ip));
    if (r === 'ok') return;
    const e = new AuthError('AUTH_RATE');
    if (r === 'first') log.error('auth.login_failed', {}, e); // once per bucket and window, not once per refused request
    throw e;
  }

  const byUser = createRateTable({ now, windowMs: RATE_WINDOW_MS, cap: USER_RATE_MAX, overflowCap: USER_RATE_MAX * 20, maxKeys: USER_RATE_KEYS, aggregate: () => 'overflow' });
  const userRateOk = (userId) => byUser(String(userId)) === 'ok';

  // ---------- sessions ----------
  const expired = (s, at) => at >= s.expiresAt || at - s.lastSeenAt >= SESSION_IDLE_MS;
  const tokenOk = (t) => typeof t === 'string' && t.length > 0 && t.length <= 256;

  function userForSession(token) {
    if (!tokenOk(token)) return null;
    const id = sha256(token);
    const s = sessions.map.get(id);
    if (!sessionDoc(s)) return null;
    const at = now();
    // (a session is checked for expiry before its user, a key after: an expired session is deleted on sight, a key of a vanished
    // user is left for the sweep)
    if (expired(s, at)) { dropSession(id); return null; }
    const user = userDoc(s.userId);
    if (user && at - s.lastSeenAt >= SEEN_SAVE_MS) { s.lastSeenAt = at; sessions.save(id); }
    return user;
  }

  // ---------- durability ----------
  // unconfirmed: the ids removed by a logout, a revoke or a mint whose write is not confirmed yet (lib/durable.js).
  const { durable, unconfirmed } = createDurable({ store, canRevoke });

  // Whether the logout is durable. The session is gone in memory at once. A token that names nothing (or a session an earlier
  // logout already removed and the store has confirmed) costs no I/O: it answers whether the store can take revocations at all.
  async function logout(token) {
    if (!tokenOk(token)) return canRevoke();
    const id = sha256(token);
    if (!sessions.map.has(id)) return unconfirmed.has(`session:${id}`) ? durable('session', [id]) : canRevoke();
    dropSession(id);
    const ok = await durable('session', [id]);
    if (ok) log.info('auth.logout', { kind: 'session' });
    return ok;
  }

  function sweep() {
    const at = now();
    for (const [id, s] of [...sessions.map]) {
      if (sessionDoc(s) && !expired(s, at) && !isBlocked(s.userId)) continue;
      dropSession(id);
    }
    for (const [id, k] of agentKeys.map) if (!keyDoc(k)) dropKey(id);
    for (const userId of [...keyByUser.keys()]) {
      if (isBlocked(userId)) for (const id of [...keyByUser.get(userId)]) dropKey(id);
      else liveKeyIds(userId, at, { drop: true });
    }
    if (unconfirmed.size) { // whatever the store has since made durable is no longer owed
      const seen = [...unconfirmed.keys()];
      store.settle().then((ok) => { if (ok) for (const k of seen) unconfirmed.delete(k); }, () => {});
    }
  }

  // ---------- agent keys ----------
  function userForAgentKey(key) {
    if (!tokenOk(key)) return null;
    const id = sha256(key);
    const k = agentKeys.map.get(id);
    if (!keyDoc(k)) return null;
    const user = userDoc(k.userId);
    if (!user) return null;
    const at = now();
    if (keyIdle(k, at)) { dropKey(id); return null; }
    // lastUsedAt moves on every use (the idle check sees it); the first use is saved, then at most once a day since the last save
    if (!lastSaved.has(id)) lastSaved.set(id, Number.isFinite(k.lastUsedAt) ? k.lastUsedAt : -Infinity);
    const first = neverUsed(k);
    k.lastUsedAt = at;
    if (first || at - lastSaved.get(id) >= KEY_SEEN_SAVE_MS) { agentKeys.save(id); lastSaved.set(id, at); }
    return user;
  }

  // The user's live keys, newest first, as the public view of them: { kid, name, createdAt, lastUsedAt } (lastUsedAt null until
  // the key is first used; name null for a key made without one).
  function agentKeysInfo(user) {
    return liveKeyIds(user.id, now()).map((id) => {
      const k = agentKeys.map.get(id);
      return { kid: kidOf(id), name: typeof k.name === 'string' ? k.name : null, createdAt: k.createdAt, lastUsedAt: neverUsed(k) ? null : k.lastUsedAt };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  // Whether a key called `name` could be minted for the user: { ok: true, name } (name cleaned; null for none), or { ok: false,
  // reason: 'name' | 'name_taken' | 'limit' }. Synchronous. Only the user's live keys count (an idle one does not), and nothing is
  // changed: dropping the idle ones is mint's job.
  function checkMint(user, name) {
    const cleaned = cleanText(name, KEY_NAME_MAX);
    if (cleaned === null) return { ok: false, reason: 'name' };
    const keyName = cleaned || null;
    const live = liveKeyIds(user.id, now());
    const lower = cleaned.toLowerCase();
    if (keyName && live.some((id) => { const n = agentKeys.map.get(id).name; return typeof n === 'string' && n.toLowerCase() === lower; })) return { ok: false, reason: 'name_taken' };
    if (live.length >= MAX_KEYS_PER_USER) return { ok: false, reason: 'limit' };
    return { ok: true, name: keyName };
  }

  // A new key, once ({ ok: true, key, kid, name, createdAt }); it replaces nothing. Otherwise { ok: false, reason }: the checkMint
  // reasons (re-checked here, synchronously, before anything is made), or 'saving' (the store cannot keep it now, or the user is
  // blocked, or the write failed). A failed write removes only the new key and forgets it. If the
  // store did take the insert (an ambiguous failure), the record can come back at the next load: nobody ever saw its secret, so it
  // only lists as "Not used yet" and counts toward the limit until it is deleted or goes idle. Accepted (2026-10-08 review).
  async function mintAgentKey(user, name) {
    liveKeyIds(user.id, now(), { drop: true }); // the user's idle keys go first, so they do not count against the limit
    const c = checkMint(user, name);
    if (!c.ok) return c;
    if (!canRevoke() || isBlocked(user.id)) return { ok: false, reason: 'saving' };
    const key = 'bh_' + token32();
    const id = sha256(key);
    const createdAt = now();
    putKey(id, { userId: user.id, name: c.name, createdAt, lastUsedAt: null });
    if (await durable('agentkey', [id], user.id)) return { ok: true, key, kid: kidOf(id), name: c.name, createdAt };
    dropKey(id);
    unconfirmed.delete('agentkey:' + id);
    return { ok: false, reason: 'saving' };
  }

  // Whether the revoke of the user's key `kid` is durable. A kid that names none of the user's keys revokes nothing (another
  // user's kid included). A repeat that finds no key but has one still owed to the store waits for it, else it asks canRevoke().
  async function revokeAgentKey(user, kid) {
    for (const id of keyByUser.get(user.id) || []) {
      if (kidOf(id) === kid) { dropKey(id); return durable('agentkey', [id], user.id); }
    }
    const owed = [...unconfirmed.values()].filter((e) => e.kind === 'agentkey' && e.userId === user.id && kidOf(e.id) === kid).map((e) => e.id);
    return owed.length ? durable('agentkey', owed, user.id) : canRevoke();
  }

  return { beginLogin, completeLogin, userRateOk, userForSession, userForAgentKey, userInfo: userDoc, logout, sweep, mintAgentKey, checkMint, revokeAgentKey, agentKeysInfo };
}

module.exports = { createAuth, NEXT_PATHS, MAX_KEYS_PER_USER, KEY_NAME_MAX, KID };
