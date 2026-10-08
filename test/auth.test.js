'use strict';
// GitHub sign-in: lib/auth.js on its own (a fake GitHub behind an injected fetch, a real file store, a manual clock), then the
// whole thing over HTTP in-process (lib/http.js: cookies, Origin and content-type guards, the routes). Node-18-safe.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createAuth } = require('../lib/auth');
const { createApp, bootApp } = require('../lib/app');
const { createStore } = require('../lib/store');
const { loadConfig, loadSecrets, ConfigError } = require('../lib/config');
const { createLog } = require('../lib/log');
const { AuthError } = require('../lib/errors');
const { createHttpServer } = require('../lib/http');
const { mkTmp, rmTmp } = require('../test-support/server');
const { PG_URL, scratchDatabase } = require('../test-support/pg');
const { fakeProxy, quietLog } = require('../test-support/app');

const T = { timeout: 30000 };
const PUBLIC = 'https://behalf.test';
const CLIENT_ID = 'client-id-VALUE';
const CLIENT_SECRET = 'client-secret-VALUE';
const GH_TOKEN = 'gho_ACCESSTOKEN123';
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const secrets = () => loadSecrets({ GITHUB_CLIENT_ID: CLIENT_ID, GITHUB_CLIENT_SECRET: CLIENT_SECRET });
const cfg = (extra = {}) => loadConfig({ SIGNIN: 'github', PUBLIC_URL: PUBLIC, GITHUB_BLOCKED_IDS: '666', ...extra });

// A GitHub that knows one good code. Everything it was asked is in calls; each failure mode is a field a test sets.
function fakeGithub(opts = {}) {
  const gh = {
    id: 1001, login: 'octocat', accessToken: GH_TOKEN, code: 'good-code', challenge: null, calls: [], network: false,
    tokenResponse: null, profileResponse: null, ...opts,
  };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  gh.fetch = async (url, init = {}) => {
    gh.calls.push({ url: String(url), init });
    if (gh.network) throw new TypeError('network failure GHTEXT');
    if (String(url) === 'https://github.com/login/oauth/access_token') {
      if (gh.tokenResponse) return gh.tokenResponse();
      const body = JSON.parse(init.body);
      const pkce = gh.challenge === null || crypto.createHash('sha256').update(String(body.code_verifier)).digest('base64url') === gh.challenge;
      if (body.code !== gh.code || body.client_secret !== CLIENT_SECRET || body.client_id !== CLIENT_ID || !pkce) {
        return json(200, { error: 'bad_verification_code', error_description: 'GHTEXT The code passed is incorrect' }); // GitHub answers 200
      }
      return json(200, { access_token: gh.accessToken, token_type: 'bearer', scope: '' });
    }
    if (String(url) === 'https://api.github.com/user') {
      if (gh.profileResponse) return gh.profileResponse();
      if (init.headers && init.headers.authorization !== `Bearer ${gh.accessToken}`) return json(401, { message: 'Bad credentials GHTEXT' });
      return json(200, { id: gh.id, login: gh.login, name: 'GHTEXT Name', email: 'a@b.test' });
    }
    throw new Error('unexpected url ' + url);
  };
  return gh;
}

const mkClock = (t = 1700000000000) => { const c = { t, now: () => c.t }; return c; };
const ALL_LOGS = []; // every line any captured logger in this file wrote, for the global assertion at the end
const capture = () => { const out = []; return { out, log: createLog({ stream: { write: (s) => { out.push(s); ALL_LOGS.push(s); } } }) }; };

// What lib/app.js hands auth: whether a revocation may be attempted (the store is not failing).
const canRevokeOf = (store) => () => store.health().failingSince === null;

// A loaded file store, wrapped so a test can see persist() and make the store fail.
function wrapStore(store, { persist } = {}) {
  const w = Object.create(store);
  w.persistCalls = [];
  w.failing = false;
  w.persist = async (kind, id) => { w.persistCalls.push([kind, id]); return persist ? persist(kind, id) : store.persist(kind, id); };
  w.health = () => (w.failing ? { ok: false, failingSince: 1 } : store.health());
  return w;
}

function mkStore(t, log) {
  const dir = mkTmp('auth-');
  const file = path.join(dir, 'rooms.json');
  const store = createStore({ file, log: log || quietLog() });
  store.load();
  t.after(async () => { await store.close(); rmTmp(dir); });
  return { store, file };
}

function mkAuth(t, { gh = fakeGithub(), config = cfg(), clock = mkClock(), random, persist } = {}) {
  const { out, log } = capture();
  const { store: base, file } = mkStore(t, log);
  const store = wrapStore(base, { persist });
  const auth = createAuth({ store, config, secrets: secrets(), canRevoke: canRevokeOf(store), fetch: gh.fetch, clock, log, random });
  return { auth, store, file, gh, clock, out, checkRate: (ip) => callbackFrom({ auth }, ip), users: store.collection('user').map, sessions: store.collection('session').map, keys: store.collection('agentkey').map };
}

// One callback attempt from `ip` that gets as far as the limiter (a valid state) and no further (no code): resolves when the limiter
// let it through, rejects with the AuthError (AUTH_RATE) when it did not. checkRate is internal to lib/auth.js.
async function callbackFrom(h, ip) {
  const b = h.auth.beginLogin();
  const e = await failure(h.auth.completeLogin({ code: '', state: b.state, expected: b, ip }));
  if (e.code === 'AUTH_RATE') throw e;
}

// begin + complete in one go, the way the browser would.
async function login(h, next, ip) {
  const begin = h.auth.beginLogin(next);
  h.gh.challenge = new URL(begin.location).searchParams.get('code_challenge');
  return h.auth.completeLogin({ code: h.gh.code, state: begin.state, expected: begin, ip });
}

async function failure(promise) {
  try { await promise; } catch (e) { return e; }
  assert.fail('expected a failure');
}

// ---------- beginLogin ----------
test('beginLogin: the redirect carries PKCE S256, the exact redirect_uri and no scope', (t) => {
  const { auth } = mkAuth(t);
  const b = auth.beginLogin('/connect');
  const u = new URL(b.location);
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(u.searchParams.get('redirect_uri'), PUBLIC + '/auth/github/callback');
  assert.equal(u.searchParams.get('state'), b.state);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('code_challenge'), crypto.createHash('sha256').update(b.verifier).digest('base64url'));
  assert.equal(u.searchParams.has('scope'), false);
  assert.equal(u.searchParams.has('client_secret'), false);
  assert.ok(!b.location.includes(b.verifier), 'the verifier is never sent to GitHub in the redirect');
  assert.match(b.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(b.state, /^[A-Za-z0-9_-]{22,}$/);
  assert.notEqual(auth.beginLogin().state, auth.beginLogin().state);
});

test('beginLogin: next is one of /, /start, /connect, else /', (t) => {
  const { auth } = mkAuth(t);
  for (const ok of ['/', '/start', '/connect']) assert.equal(auth.beginLogin(ok).next, ok);
  for (const bad of [undefined, null, '', '/room/abc', 'https://evil.test', '//evil.test', '/\\evil.test', '/start/', '/connect?x=1', 7, {}]) assert.equal(auth.beginLogin(bad).next, '/', String(bad));
});

test('beginLogin takes its randomness from the injected source', (t) => {
  const { auth } = mkAuth(t);
  const h = mkAuth(t, { random: (n) => Buffer.alloc(n, 7) });
  assert.equal(h.auth.beginLogin().state, Buffer.alloc(32, 7).toString('base64url'));
  assert.notEqual(auth.beginLogin().state, Buffer.alloc(32, 7).toString('base64url'));
});

// ---------- completeLogin ----------
test('completeLogin: the happy path stores a hashed session and a user, and keeps the GitHub token nowhere', T, async (t) => {
  const h = mkAuth(t);
  const out = await login(h, '/connect');
  assert.deepEqual(out.user, { login: 'octocat' });
  assert.equal(out.next, '/connect');
  assert.match(out.token, /^[A-Za-z0-9_-]{43}$/);
  // The exchange: the secret, the code, the redirect_uri and the verifier go in the body, with a bounded time.
  const [ex, prof] = h.gh.calls;
  assert.equal(ex.url, 'https://github.com/login/oauth/access_token');
  assert.equal(ex.init.method, 'POST');
  assert.equal(ex.init.headers.accept, 'application/json');
  const body = JSON.parse(ex.init.body);
  assert.deepEqual(Object.keys(body).sort(), ['client_id', 'client_secret', 'code', 'code_verifier', 'redirect_uri']);
  assert.equal(body.redirect_uri, PUBLIC + '/auth/github/callback');
  assert.ok(ex.init.signal instanceof AbortSignal && !ex.init.signal.aborted, 'the exchange has a timeout');
  assert.equal(prof.url, 'https://api.github.com/user');
  assert.equal(prof.init.headers.authorization, 'Bearer ' + GH_TOKEN);
  assert.equal(prof.init.headers['user-agent'], 'behalf');
  assert.equal(prof.init.headers.accept, 'application/vnd.github+json');
  assert.ok(prof.init.signal instanceof AbortSignal && !prof.init.signal.aborted, 'the profile read has a timeout');
  // Stored: the user by numeric id, the session by the hash of the token.
  assert.deepEqual(h.users.get('1001'), { id: '1001', login: 'octocat', createdAt: h.clock.t, lastLoginAt: h.clock.t });
  assert.deepEqual([...h.sessions.keys()], [sha256(out.token)]);
  assert.deepEqual(h.sessions.get(sha256(out.token)), { userId: '1001', createdAt: h.clock.t, expiresAt: h.clock.t + 30 * DAY, lastSeenAt: h.clock.t });
  // Nothing durable or logged holds a token, in any form.
  await h.store.settle();
  const all = JSON.stringify([...h.users, ...h.sessions, ...h.keys]) + fs.readFileSync(h.file, 'utf8');
  assert.ok(all.includes(sha256(out.token)), 'the file holds the session by its hash');
  for (const secret of [GH_TOKEN, out.token]) assert.ok(!all.includes(secret), 'a token was stored');
  const logged = h.out.join('');
  for (const secret of [GH_TOKEN, out.token, 'good-code', 'octocat', '1001', CLIENT_SECRET, CLIENT_ID]) assert.ok(!logged.includes(secret), 'logged: ' + secret);
  assert.match(logged, /event="auth\.login"/);
});

test('completeLogin: the session token is fresh each time and unrelated to the OAuth state', T, async (t) => {
  const h = mkAuth(t);
  const a = await login(h);
  const b = await login(h);
  assert.notEqual(a.token, b.token);
  assert.equal(h.sessions.size, 2);
});

test('completeLogin: a state that does not match, differs in length, or is empty is AUTH_STATE and GitHub is never called', T, async (t) => {
  const h = mkAuth(t);
  const b = h.auth.beginLogin();
  const cases = [
    ['other', b.state.replace(/./, (c) => (c === 'A' ? 'B' : 'A'))],
    ['short', b.state.slice(0, 5)],
    ['long', b.state + 'x'],
    ['multibyte', 'é'.repeat(b.state.length)],
    ['empty', ''], ['null', null], ['undefined', undefined], ['object', { toString: () => b.state }],
  ];
  for (const [name, state] of cases) {
    const e = await failure(h.auth.completeLogin({ code: 'good-code', state, expected: b }));
    assert.ok(e instanceof AuthError && e.code === 'AUTH_STATE', name);
  }
  for (const expected of [null, undefined, {}, { state: '', verifier: 'v' }, { state: b.state, verifier: '' }, 'x', []]) {
    const e = await failure(h.auth.completeLogin({ code: 'good-code', state: '', expected }));
    assert.equal(e.code, 'AUTH_STATE', JSON.stringify(expected));
    const e2 = await failure(h.auth.completeLogin({ code: 'good-code', state: b.state, expected }));
    assert.equal(e2.code, 'AUTH_STATE', JSON.stringify(expected));
  }
  assert.equal((await failure(h.auth.completeLogin())).code, 'AUTH_STATE');
  assert.equal(h.gh.calls.length, 0);
  assert.equal(h.sessions.size, 0);
});

test('completeLogin: a missing code, a bad code (GitHub answers 200 with an error body) and a token of the wrong kind are AUTH_EXCHANGE', T, async (t) => {
  const h = mkAuth(t);
  const run = (code) => { const b = h.auth.beginLogin(); return failure(h.auth.completeLogin({ code, state: b.state, expected: b })); }; // a state works once
  for (const code of [null, undefined, '', 7, 'x'.repeat(513)]) assert.equal((await run(code)).code, 'AUTH_EXCHANGE', String(code));
  assert.equal(h.gh.calls.length, 0);
  const e = await run('wrong-code');
  assert.ok(e instanceof AuthError && e.code === 'AUTH_EXCHANGE');
  assert.equal(h.gh.calls.length, 1, 'no profile read after a failed exchange');
  const json = (status, body) => () => new Response(JSON.stringify(body), { status });
  for (const [name, resp] of [
    ['no token', json(200, { token_type: 'bearer' })],
    ['token not a string', json(200, { access_token: 5, token_type: 'bearer' })],
    ['empty token', json(200, { access_token: '', token_type: 'bearer' })],
    ['wrong type', json(200, { access_token: GH_TOKEN, token_type: 'mac' })],
    ['no type', json(200, { access_token: GH_TOKEN })],
    ['http 500', json(500, { access_token: GH_TOKEN, token_type: 'bearer' })],
    ['not json', () => new Response('<html>', { status: 200 })],
    ['null body', json(200, null)],
    ['array body', json(200, [])],
  ]) {
    h.gh.tokenResponse = resp;
    const err = await run('good-code');
    assert.equal(err.code, 'AUTH_EXCHANGE', name);
  }
  h.gh.tokenResponse = null;
  h.gh.network = true;
  assert.equal((await run('good-code')).code, 'AUTH_EXCHANGE', 'a network error');
  assert.equal(h.sessions.size, 0);
  assert.equal(h.users.size, 0);
});

test('completeLogin: a profile that cannot be read or is malformed is AUTH_PROFILE, and no account is made', T, async (t) => {
  const h = mkAuth(t);
  const run = async () => { const b = h.auth.beginLogin(); return failure(h.auth.completeLogin({ code: 'good-code', state: b.state, expected: b })); };
  const json = (status, body) => () => new Response(JSON.stringify(body), { status });
  for (const [name, resp] of [
    ['401', json(401, { message: 'Bad credentials' })],
    ['no id', json(200, { login: 'octocat' })],
    ['string id', json(200, { id: '1001', login: 'octocat' })],
    ['float id', json(200, { id: 1.5, login: 'octocat' })],
    ['zero id', json(200, { id: 0, login: 'octocat' })],
    ['unsafe id', json(200, { id: 2 ** 60, login: 'octocat' })],
    ['no login', json(200, { id: 1 })],
    ['login with a space', json(200, { id: 1, login: 'octo cat' })],
    ['login with markup', json(200, { id: 1, login: '<b>x</b>' })],
    ['login too long', json(200, { id: 1, login: 'a'.repeat(40) })],
    ['not json', () => new Response('nope', { status: 200 })],
    ['null', json(200, null)],
  ]) {
    h.gh.profileResponse = resp;
    const e = await run();
    assert.ok(e instanceof AuthError && e.code === 'AUTH_PROFILE', name);
  }
  h.gh.profileResponse = () => { throw new TypeError('boom GHTEXT'); };
  assert.equal((await run()).code, 'AUTH_PROFILE', 'a network error');
  assert.equal(h.users.size, 0);
  assert.equal(h.sessions.size, 0);
});

test('an AuthError has a fixed message and a code the logger accepts, and no failure leaks GitHub text, the code or the state', T, async (t) => {
  const h = mkAuth(t);
  const b = h.auth.beginLogin();
  h.gh.tokenResponse = null;
  const bad = await failure(h.auth.completeLogin({ code: 'SECRETCODE-1', state: b.state, expected: b }));
  assert.equal(bad.message, 'Sign-in failed');
  for (const text of [bad.message, String(bad), require('node:util').inspect(bad), JSON.stringify(bad)]) assert.ok(!/GHTEXT|SECRETCODE/.test(text), text);
  const wrong = await failure(h.auth.completeLogin({ code: 'good-code', state: 'SECRETSTATE-1', expected: b }));
  const logged = h.out.join('');
  assert.ok(!/GHTEXT|SECRETCODE|SECRETSTATE/.test(logged), logged);
  assert.match(logged, /event="auth\.login_failed" errorClass="AuthError" code="AUTH_EXCHANGE"/);
  assert.match(logged, /event="auth\.login_failed" errorClass="AuthError" code="AUTH_STATE"/);
  assert.equal(wrong.code, 'AUTH_STATE');
  for (const code of ['AUTH_STATE', 'AUTH_EXCHANGE', 'AUTH_PROFILE', 'AUTH_BLOCKED', 'AUTH_RATE']) assert.equal(require('../lib/log').errorFields(new AuthError(code)).code, code);
});

test('completeLogin: the user is keyed by the numeric id, so a renamed account is the same user', T, async (t) => {
  const h = mkAuth(t);
  await login(h);
  const created = h.users.get('1001').createdAt;
  h.clock.t += 3 * DAY;
  h.gh.login = 'renamed-cat';
  await login(h);
  assert.equal(h.users.size, 1);
  assert.deepEqual(h.users.get('1001'), { id: '1001', login: 'renamed-cat', createdAt: created, lastLoginAt: h.clock.t });
  h.gh.id = 1002; h.gh.login = 'octocat'; // another account that now holds the old name
  await login(h);
  assert.deepEqual([...h.users.keys()].sort(), ['1001', '1002']);
  assert.equal(h.users.get('1002').login, 'octocat');
});

test('completeLogin: a blocked id is AUTH_BLOCKED and leaves no user and no session', T, async (t) => {
  const h = mkAuth(t, { gh: fakeGithub({ id: 666 }) });
  const b = h.auth.beginLogin();
  const e = await failure(h.auth.completeLogin({ code: 'good-code', state: b.state, expected: b }));
  assert.ok(e instanceof AuthError && e.code === 'AUTH_BLOCKED');
  assert.equal(h.users.size + h.sessions.size, 0);
  h.gh.id = 667;
  await login(h); // a neighbour is fine
});

test('completeLogin: next comes from the cookie and is checked again here', T, async (t) => {
  const h = mkAuth(t);
  for (const [next, want] of [['/start', '/start'], ['/connect', '/connect'], ['/', '/'], ['https://evil.test', '/'], ['//evil.test', '/'], ['/room/x', '/'], ['', '/'], [undefined, '/']]) {
    const b = h.auth.beginLogin();
    const out = await h.auth.completeLogin({ code: 'good-code', state: b.state, expected: { ...b, next } });
    assert.equal(out.next, want, String(next));
  }
});

// ---------- sessions ----------
test('userForSession: a valid token gives { id, login }, anything else gives null', T, async (t) => {
  const h = mkAuth(t);
  const { token } = await login(h);
  assert.deepEqual(h.auth.userForSession(token), { id: '1001', login: 'octocat' });
  for (const bad of [undefined, null, '', 'nope', token + 'x', token.toUpperCase(), 7, {}, [], 'x'.repeat(300)]) assert.equal(h.auth.userForSession(bad), null, String(bad));
  assert.equal(h.auth.userForSession(sha256(token)), null, 'the stored id is not a token');
});

test('userForSession: lastSeenAt slides, is saved at most hourly, and the idle timeout is 7 days', T, async (t) => {
  const h = mkAuth(t);
  const { token } = await login(h);
  const id = sha256(token);
  const t0 = h.clock.t;
  h.clock.t = t0 + HOUR - 1;
  assert.ok(h.auth.userForSession(token));
  assert.equal(h.sessions.get(id).lastSeenAt, t0, 'not rewritten within the hour');
  h.clock.t = t0 + HOUR;
  assert.ok(h.auth.userForSession(token));
  assert.equal(h.sessions.get(id).lastSeenAt, t0 + HOUR, 'rewritten after an hour');
  // Used every 6 days it stays valid well past 7 days from login.
  h.clock.t = t0 + 6 * DAY; assert.ok(h.auth.userForSession(token));
  h.clock.t = t0 + 12 * DAY; assert.ok(h.auth.userForSession(token));
  h.clock.t = t0 + 18 * DAY; assert.ok(h.auth.userForSession(token));
  // Unused for 7 days: gone, and deleted.
  h.clock.t = t0 + 18 * DAY + 7 * DAY - 1; assert.ok(h.auth.userForSession(token));
  h.clock.t += 7 * DAY;
  assert.equal(h.auth.userForSession(token), null);
  assert.equal(h.sessions.has(id), false, 'an expired session is deleted');
});

test('userForSession: the hard cap is 30 days from login, however often it is used', T, async (t) => {
  const h = mkAuth(t);
  const { token } = await login(h);
  const t0 = h.clock.t;
  for (let d = 5; d < 30; d += 5) { h.clock.t = t0 + d * DAY; assert.ok(h.auth.userForSession(token), 'day ' + d); }
  h.clock.t = t0 + 30 * DAY - 1;
  assert.ok(h.auth.userForSession(token));
  h.clock.t = t0 + 30 * DAY;
  assert.equal(h.auth.userForSession(token), null);
  assert.equal(h.sessions.size, 0);
});

test('userForSession: a malformed session record counts as absent, and so does one whose user is gone', T, async (t) => {
  const h = mkAuth(t);
  const { token } = await login(h);
  const id = sha256(token);
  const good = { ...h.sessions.get(id) };
  for (const [name, doc] of [
    ['userId a number', { ...good, userId: 1001 }],
    ['no userId', { ...good, userId: undefined }],
    ['expiresAt a string', { ...good, expiresAt: String(good.expiresAt) }],
    ['expiresAt missing', { ...good, expiresAt: undefined }],
    ['expiresAt NaN', { ...good, expiresAt: NaN }],
    ['expiresAt Infinity', { ...good, expiresAt: Infinity }],
    ['lastSeenAt a string', { ...good, lastSeenAt: 'x' }],
    ['lastSeenAt null', { ...good, lastSeenAt: null }],
    ['a string', 'session'],
    ['an array', []],
    ['null', null],
  ]) {
    h.sessions.set(id, doc);
    assert.equal(h.auth.userForSession(token), null, name);
  }
  h.sessions.set(id, good);
  assert.ok(h.auth.userForSession(token));
  h.users.delete('1001');
  assert.equal(h.auth.userForSession(token), null, 'user gone');
  h.users.set('1001', { id: '1001', login: 5 });
  assert.equal(h.auth.userForSession(token), null, 'user without a login');
});

test('a user keeps at most 10 sessions: the oldest is dropped, other users are not touched', T, async (t) => {
  const h = mkAuth(t);
  const tokens = [];
  h.gh.id = 2002; h.gh.login = 'other';
  const other = (await login(h)).token;
  h.gh.id = 1001; h.gh.login = 'octocat';
  for (let i = 0; i < 12; i++) { tokens.push((await login(h)).token); h.clock.t += 1000; }
  const mine = [...h.sessions.values()].filter((s) => s.userId === '1001');
  assert.equal(mine.length, 10);
  assert.equal(h.auth.userForSession(tokens[0]), null);
  assert.equal(h.auth.userForSession(tokens[1]), null);
  for (const tok of tokens.slice(2)) assert.ok(h.auth.userForSession(tok));
  assert.ok(h.auth.userForSession(other));
  assert.equal(h.sessions.size, 11);
});

test('sweep drops expired and malformed sessions and keeps the rest', T, async (t) => {
  const h = mkAuth(t);
  const old = (await login(h)).token;
  h.clock.t += 8 * DAY;
  const fresh = (await login(h)).token;
  h.sessions.set('bad-doc', { userId: 5 });
  h.auth.sweep();
  assert.deepEqual([...h.sessions.keys()], [sha256(fresh)]);
  assert.equal(h.auth.userForSession(old), null);
  assert.ok(h.auth.userForSession(fresh));
});

// ---------- logout ----------
test('logout stores the deletion before it answers, and does nothing, with no write, when there was no session', T, async (t) => {
  const h = mkAuth(t);
  const { token } = await login(h);
  assert.equal(await h.auth.logout(token), true);
  assert.deepEqual(h.store.persistCalls, [['session', sha256(token)]]);
  assert.equal(h.auth.userForSession(token), null);
  assert.equal(h.sessions.size, 0);
  h.store.persistCalls.length = 0;
  for (const none of [token, 'unknown', '', undefined, null, 7]) assert.equal(await h.auth.logout(none), true, String(none));
  assert.deepEqual(h.store.persistCalls, [], 'no session, no persist');
  assert.match(h.out.join(''), /event="auth\.logout" kind="session"/);
});

test('logout answers false when the write did not land, and attempts no write while the store is failing (the session is gone in memory either way)', T, async (t) => {
  const h = mkAuth(t, { persist: async () => false });
  const { token } = await login(h);
  assert.equal(await h.auth.logout(token), false);
  const h2 = mkAuth(t);
  const s2 = (await login(h2)).token;
  h2.store.failing = true;
  assert.equal(await h2.auth.logout(s2), false);
  assert.deepEqual(h2.store.persistCalls, [], 'no write attempted while failing');
  assert.equal(h2.auth.userForSession(s2), null, 'the logout still took effect in memory: only its durability is in doubt');
  assert.equal(await h2.auth.logout(s2), false, 'a repeat has nothing left to remove but must not say done while the store is failing');
  h2.store.failing = false;
  assert.equal(await h2.auth.logout(s2), true, 'and once the store is back it is durable');
});

// ---------- agent keys ----------
const kidOf = (id) => sha256('kid:' + id).slice(0, 12);

// A second auth over the harness's store that records which agent key records it marks for saving (a restart on the same data).
function spiedAuth(h) {
  const saves = [];
  const store = Object.create(h.store);
  store.collection = (kind) => {
    const c = h.store.collection(kind);
    if (kind !== 'agentkey') return c;
    return { map: c.map, save: (id) => { saves.push(id); c.save(id); } };
  };
  const auth = createAuth({ store, canRevoke: canRevokeOf(h.store), config: cfg(), secrets: secrets(), fetch: h.gh.fetch, clock: h.clock, log: quietLog() });
  return { auth, saves };
}

test('mintAgentKey: bh_ + 32 random bytes, stored by hash with its name, replacing nothing, confirmed before it answers', T, async (t) => {
  const h = mkAuth(t);
  const { token } = await login(h);
  const user = h.auth.userForSession(token);
  assert.deepEqual(h.auth.agentKeysInfo(user), []);
  const first = await h.auth.mintAgentKey(user, '  Claude Desktop ');
  assert.match(first.key, /^bh_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'key', 'kid', 'name', 'ok']);
  assert.equal(first.ok, true);
  assert.equal(first.createdAt, h.clock.t);
  assert.equal(first.name, 'Claude Desktop');
  assert.equal(first.kid, kidOf(sha256(first.key)), 'the kid is the first 12 hex of sha256("kid:" + id)');
  assert.deepEqual([...h.keys.keys()], [sha256(first.key)]);
  assert.deepEqual(h.keys.get(sha256(first.key)), { userId: '1001', name: 'Claude Desktop', createdAt: h.clock.t, lastUsedAt: null });
  assert.ok(!JSON.stringify([...h.keys]).includes(first.key), 'only the hash is stored');
  assert.ok(!JSON.stringify([...h.keys]).includes(first.kid), 'and the kid is derived, never stored');
  assert.deepEqual(h.auth.agentKeysInfo(user), [{ kid: first.kid, name: 'Claude Desktop', createdAt: h.clock.t, lastUsedAt: null }], 'not used yet');
  assert.deepEqual(h.store.persistCalls, [['agentkey', sha256(first.key)]]);
  h.clock.t += 1000;
  assert.deepEqual(h.auth.userForAgentKey(first.key), { id: '1001', login: 'octocat' });
  assert.equal(h.auth.agentKeysInfo(user)[0].lastUsedAt, h.clock.t, 'the first use shows');
  h.clock.t += 1000;
  h.store.persistCalls.length = 0;
  const second = await h.auth.mintAgentKey(user, '');
  assert.notEqual(second.key, first.key);
  assert.notEqual(second.kid, first.kid);
  assert.equal(second.name, null);
  assert.equal(h.keys.size, 2, 'a new key replaces nothing');
  assert.ok(h.auth.userForAgentKey(first.key), 'the old key still works');
  assert.ok(h.auth.userForAgentKey(second.key));
  assert.deepEqual(h.store.persistCalls, [['agentkey', sha256(second.key)]], 'only the new key is confirmed');
  assert.deepEqual(h.auth.agentKeysInfo(user).map((k) => k.kid), [second.kid, first.kid], 'newest first');
  for (const bad of [undefined, null, '', 'bh_', first.key + 'x', token, 7]) assert.equal(h.auth.userForAgentKey(bad), null, String(bad));
});

test('key names: cleaned by lib/text.js, counted in code points, a lone surrogate or a non-string refused', T, async (t) => {
  const h = mkAuth(t);
  const user = h.auth.userForSession((await login(h)).token);
  // (each key is deleted again, so the count never reaches the limit)
  const name = async (v) => {
    const r = await h.auth.mintAgentKey(user, v);
    if (!r.ok) return r.reason;
    assert.equal(await h.auth.revokeAgentKey(user, r.kid), true);
    return r.name;
  };
  assert.equal(await name('Claude\u{202E} Desk\u{200B}top\u0007\u0000'), 'Claude Desktop', 'bidi override, zero-width space and controls are removed');
  assert.equal(await name('a\u{2028}b\u{AD}c\u{FEFF}d'), 'a bcd', 'a line separator is a space; format characters are removed');
  assert.equal(await name('Cafe\u{301}'), 'Caf\u{E9}', 'NFC');
  assert.equal(await name('\u{1F600}'.repeat(40)), '\u{1F600}'.repeat(40), '40 code points is allowed, though 80 UTF-16 units');
  assert.equal(await name('\u{1F600}'.repeat(41)), 'name', '41 code points is too long');
  assert.equal(await name('x'.repeat(40) + '\u{200B}'), 'x'.repeat(40), 'length is counted after stripping');
  assert.equal(await name('\u{D83D}'), 'name', 'a lone high surrogate is refused');
  assert.equal(await name('ab\u{DE00}'), 'name', 'a lone low surrogate is refused');
  for (const bad of [undefined, null, 7, {}, [], true]) assert.equal(await name(bad), 'name', 'a name is a string: ' + JSON.stringify(bad));
  for (const none of ['', '   ', '\u{200B}\u{202E}', '\u{2800}\u{3164}', '\u{301}']) assert.equal(await name(none), null, 'no name: ' + JSON.stringify(none));
  assert.equal(h.keys.size, 0);
});

test('a name is unique among the user\'s live keys, case-insensitively, after cleaning; an empty name never clashes', T, async (t) => {
  const h = mkAuth(t);
  const user = h.auth.userForSession((await login(h)).token);
  const code = await h.auth.mintAgentKey(user, 'Claude Code');
  assert.ok(code.ok);
  for (const same of ['Claude Code', 'CLAUDE CODE', '  claude\u{200B}   code ']) assert.deepEqual(await h.auth.mintAgentKey(user, same), { ok: false, reason: 'name_taken' }, JSON.stringify(same));
  assert.equal(h.keys.size, 1, 'a refused name made nothing');
  assert.ok((await h.auth.mintAgentKey(user, '')).ok);
  assert.ok((await h.auth.mintAgentKey(user, '')).ok, 'two keys with no name are fine');
  assert.ok((await h.auth.mintAgentKey(user, 'Claude Desktop')).ok);
  // Another user may use the same name; a deleted key frees its name.
  h.gh.id = 2002; h.gh.login = 'other';
  const other = h.auth.userForSession((await login(h)).token);
  assert.ok((await h.auth.mintAgentKey(other, 'Claude Code')).ok);
  assert.equal(await h.auth.revokeAgentKey(user, code.kid), true);
  assert.ok((await h.auth.mintAgentKey(user, 'claude code')).ok);
  // A key that has gone idle no longer holds its name.
  h.clock.t += 91 * DAY;
  assert.ok((await h.auth.mintAgentKey(user, 'Claude Desktop')).ok);
});

test('checkMint is the mint\'s checks without the mint: the same refusals, nothing made, nothing changed, nothing written', T, async (t) => {
  const h = mkAuth(t);
  const user = h.auth.userForSession((await login(h)).token);
  assert.deepEqual(h.auth.checkMint(user, '  Claude Code '), { ok: true, name: 'Claude Code' });
  assert.deepEqual(h.auth.checkMint(user, ''), { ok: true, name: null });
  assert.deepEqual(h.auth.checkMint(user, 'x'.repeat(41)), { ok: false, reason: 'name' });
  assert.deepEqual(h.auth.checkMint(user, undefined), { ok: false, reason: 'name' });
  assert.equal(h.keys.size, 0);
  const made = await h.auth.mintAgentKey(user, 'Claude Code');
  assert.deepEqual(h.auth.checkMint(user, 'claude code'), { ok: false, reason: 'name_taken' });
  h.store.persistCalls.length = 0;
  // A refusal for the name or the count comes before the store is asked: it is the same whatever the store is doing.
  h.store.failing = true;
  assert.deepEqual(await h.auth.mintAgentKey(user, 'claude code'), { ok: false, reason: 'name_taken' });
  assert.deepEqual(await h.auth.mintAgentKey(user, 'x'.repeat(41)), { ok: false, reason: 'name' });
  assert.deepEqual(await h.auth.mintAgentKey(user, 'Another'), { ok: false, reason: 'saving' });
  assert.deepEqual(h.store.persistCalls, []);
  h.store.failing = false;
  // It does not drop an idle key (mint does, before counting).
  for (let i = 0; i < 9; i++) assert.ok((await h.auth.mintAgentKey(user, '')).ok);
  assert.deepEqual(h.auth.checkMint(user, ''), { ok: false, reason: 'limit' });
  h.clock.t += 91 * DAY;
  assert.deepEqual(h.auth.checkMint(user, ''), { ok: true, name: null }, 'idle keys do not count');
  assert.equal(h.keys.size, 10, 'and checkMint dropped none');
  assert.ok((await h.auth.mintAgentKey(user, '')).ok);
  assert.equal(h.keys.size, 1, 'mint did');
  assert.equal(made.ok, true);
});

test('agent keys are per user: one user\'s mint and revoke leave another user\'s keys alone, and a kid revokes only its owner\'s key', T, async (t) => {
  const h = mkAuth(t);
  const a = h.auth.userForSession((await login(h)).token);
  h.gh.id = 2002; h.gh.login = 'other';
  const b = h.auth.userForSession((await login(h)).token);
  const ka = await h.auth.mintAgentKey(a, '');
  const kb = await h.auth.mintAgentKey(b, '');
  assert.equal(h.keys.size, 2);
  assert.equal(h.auth.userForAgentKey(ka.key).login, 'octocat');
  assert.equal(h.auth.userForAgentKey(kb.key).login, 'other');
  h.store.persistCalls.length = 0;
  assert.equal(await h.auth.revokeAgentKey(a, kb.kid), true, "a's revoke of b's kid is a revoke of nothing");
  assert.deepEqual(h.store.persistCalls, [], 'and writes nothing');
  assert.equal(h.auth.userForAgentKey(kb.key).login, 'other', "b's key is untouched");
  assert.equal(h.auth.userForAgentKey(ka.key).login, 'octocat');
  assert.equal(await h.auth.revokeAgentKey(a, ka.kid), true);
  assert.equal(h.auth.userForAgentKey(ka.key), null);
  assert.equal(h.auth.userForAgentKey(kb.key).login, 'other');
  assert.deepEqual(h.auth.agentKeysInfo(b).map((k) => k.kid), [kb.kid]);
});

test('MAX_KEYS_PER_USER: the 11th live key is refused; an idle key is dropped before counting, so it does not count', T, async (t) => {
  const h = mkAuth(t);
  const user = h.auth.userForSession((await login(h)).token);
  const made = [];
  for (let i = 0; i < 10; i++) made.push(await h.auth.mintAgentKey(user, ''));
  assert.deepEqual(await h.auth.mintAgentKey(user, ''), { ok: false, reason: 'limit' });
  assert.equal(h.keys.size, 10);
  // 50 days on, nine of them are used; 100 days after creation the tenth has been idle for more than 90 days.
  h.clock.t += 50 * DAY;
  for (const m of made.slice(0, 9)) assert.ok(h.auth.userForAgentKey(m.key));
  h.clock.t += 50 * DAY;
  const next = await h.auth.mintAgentKey(user, '');
  assert.ok(next.key, 'the idle key made room');
  assert.equal(h.keys.has(sha256(made[9].key)), false, 'and it was dropped');
  assert.equal(h.keys.size, 10);
  assert.deepEqual(await h.auth.mintAgentKey(user, ''), { ok: false, reason: 'limit' }, 'ten live keys again');
  // Another user is not limited by this one.
  h.gh.id = 2002; h.gh.login = 'other';
  assert.ok((await h.auth.mintAgentKey(h.auth.userForSession((await login(h)).token), '')).key);
});

test('a key record with no name (made before names) is a key with name null and a derived kid, and reads as not used until it is', T, async (t) => {
  const h = mkAuth(t);
  const user = h.auth.userForSession((await login(h)).token);
  const legacy = 'bh_legacy-key-without-a-name';
  const created = h.clock.t - DAY;
  h.keys.set(sha256(legacy), { userId: '1001', createdAt: created, lastUsedAt: created });
  const again = createAuth({ store: h.store, canRevoke: canRevokeOf(h.store), config: cfg(), secrets: secrets(), fetch: h.gh.fetch, clock: h.clock, log: quietLog() });
  assert.deepEqual(again.agentKeysInfo(user), [{ kid: kidOf(sha256(legacy)), name: null, createdAt: created, lastUsedAt: null }], 'a lastUsedAt equal to createdAt is a key never used');
  assert.ok(again.userForAgentKey(legacy));
  assert.equal(again.agentKeysInfo(user)[0].lastUsedAt, h.clock.t, 'and once used it says when');
  assert.equal(await again.revokeAgentKey(user, kidOf(sha256(legacy))), true);
  assert.equal(again.userForAgentKey(legacy), null);
  // A record that has a name (even null) with lastUsedAt equal to createdAt is a real use.
  const t1 = h.clock.t;
  h.keys.set('named', { userId: '1001', name: null, createdAt: t1, lastUsedAt: t1 });
  const third = createAuth({ store: h.store, canRevoke: canRevokeOf(h.store), config: cfg(), secrets: secrets(), fetch: h.gh.fetch, clock: h.clock, log: quietLog() });
  assert.equal(third.agentKeysInfo(user)[0].lastUsedAt, t1);
});

test('at load, a user\'s several nameless keys (from before names) are cut to the newest and the others are dropped from the store; keys with a name, even null, are never cut', T, async (t) => {
  const h = mkAuth(t);
  const now = h.clock.t;
  h.users.set('1001', { id: '1001', login: 'octocat', createdAt: now, lastLoginAt: now });
  h.keys.set('old-a', { userId: '1001', createdAt: now - 5000, lastUsedAt: now });
  h.keys.set('old-b', { userId: '1001', createdAt: now - 1000, lastUsedAt: now });
  h.keys.set('old-c', { userId: '1001', createdAt: now - 3000, lastUsedAt: now });
  h.keys.set('old-z', { userId: '2002', createdAt: now - 9000, lastUsedAt: now });
  h.keys.set('named-1', { userId: '1001', name: null, createdAt: now - 7000, lastUsedAt: null });
  h.keys.set('named-2', { userId: '1001', name: 'Claude Code', createdAt: now - 8000, lastUsedAt: null });
  const { auth, saves } = spiedAuth(h);
  assert.deepEqual([...h.keys.keys()].sort(), ['named-1', 'named-2', 'old-b', 'old-z']);
  assert.deepEqual(saves.sort(), ['old-a', 'old-c'], 'the dropped ones are marked for the store');
  assert.deepEqual(auth.agentKeysInfo({ id: '1001' }).map((k) => k.kid), ['old-b', 'named-1', 'named-2'].map(kidOf));
  assert.equal(auth.agentKeysInfo({ id: '2002' }).length, 1);
});

test('a key record that is damaged, or whose user is gone, is no key', T, async (t) => {
  const h = mkAuth(t);
  const user = h.auth.userForSession((await login(h)).token);
  const { key } = await h.auth.mintAgentKey(user, '');
  const id = sha256(key);
  h.keys.set(id, { userId: 7, createdAt: h.clock.t });
  assert.equal(h.auth.userForAgentKey(key), null);
  h.keys.set(id, 'x');
  assert.equal(h.auth.userForAgentKey(key), null);
  h.keys.set(id, { userId: '1001', createdAt: h.clock.t });
  assert.ok(h.auth.userForAgentKey(key));
  h.users.delete('1001');
  assert.equal(h.auth.userForAgentKey(key), null);
});

test('mintAgentKey while the store is failing changes nothing; a write that fails removes only the new key and leaves the others', T, async (t) => {
  const h = mkAuth(t);
  const user = h.auth.userForSession((await login(h)).token);
  const first = await h.auth.mintAgentKey(user, '');
  h.store.persistCalls.length = 0;
  h.store.failing = true;
  assert.deepEqual(await h.auth.mintAgentKey(user, ''), { ok: false, reason: 'saving' });
  assert.deepEqual(h.store.persistCalls, [], 'no write while failing');
  assert.ok(h.auth.userForAgentKey(first.key), 'the old key still works');
  h.store.failing = false;
  // A write that fails: the new key is gone, and the others are as they were.
  let ok = true;
  const h2 = mkAuth(t, { persist: async () => ok });
  const u2 = h2.auth.userForSession((await login(h2)).token);
  const old = await h2.auth.mintAgentKey(u2, '');
  ok = false;
  assert.deepEqual(await h2.auth.mintAgentKey(u2, ''), { ok: false, reason: 'saving' });
  assert.equal(h2.keys.size, 1, 'only the new key is removed');
  assert.ok(h2.auth.userForAgentKey(old.key), 'the earlier key still works');
  assert.deepEqual(h2.auth.agentKeysInfo(u2).map((k) => k.kid), [old.kid]);
  ok = true;
  assert.ok(await h2.auth.mintAgentKey(u2, ''), 'and minting works again');
});

test('a mint whose write fails, racing another mint or a revoke, takes away only its own key', T, async (t) => {
  // The first persist waits; a second mint (or a revoke) runs meanwhile; then the first one fails.
  for (const second of ['mint', 'revoke']) {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const h = mkAuth(t, { persist: async () => { calls++; if (calls === 2) { await gate; return false; } return true; } });
    const user = h.auth.userForSession((await login(h)).token);
    const x = await h.auth.mintAgentKey(user, ''); // persist call 1
    const racing = h.auth.mintAgentKey(user, ''); // persist call 2 (waits, then fails)
    await Promise.resolve();
    let other = null;
    if (second === 'mint') other = await h.auth.mintAgentKey(user, ''); else await h.auth.revokeAgentKey(user, x.kid);
    release();
    assert.deepEqual(await racing, { ok: false, reason: 'saving' }, second);
    if (second === 'mint') {
      assert.ok(h.auth.userForAgentKey(x.key), 'the first key is independent of the failed one');
      assert.ok(other && h.auth.userForAgentKey(other.key), 'the later mint is not undone by the earlier one failing');
      assert.equal(h.keys.size, 2);
      assert.deepEqual(h.auth.agentKeysInfo(user).map((k) => k.kid).sort(), [other.kid, x.kid].sort(), 'both are listed');
    } else {
      assert.equal(h.auth.userForAgentKey(x.key), null, 'the revoked key stays revoked');
      assert.equal(h.keys.size, 0);
    }
  }
});

test('revokeAgentKey confirms the deletion of one key by kid, writes nothing when no key has that kid, and answers false (still revoked in memory) while the store is failing', T, async (t) => {
  const h = mkAuth(t);
  const user = h.auth.userForSession((await login(h)).token);
  assert.equal(await h.auth.revokeAgentKey(user, '0123456789ab'), true);
  assert.deepEqual(h.store.persistCalls, [], 'no such key, no persist');
  const one = await h.auth.mintAgentKey(user, '');
  const two = await h.auth.mintAgentKey(user, '');
  h.store.persistCalls.length = 0;
  h.store.failing = true;
  assert.equal(await h.auth.revokeAgentKey(user, one.kid), false);
  assert.deepEqual(h.store.persistCalls, [], 'no write against a failing store');
  assert.equal(h.auth.userForAgentKey(one.key), null, 'but the key is dead in memory at once');
  assert.ok(h.auth.userForAgentKey(two.key), 'and the other key is not affected');
  assert.equal(await h.auth.revokeAgentKey(user, one.kid), false, 'a retry while it is still failing is not "done" either');
  h.store.failing = false;
  assert.equal(await h.auth.revokeAgentKey(user, one.kid), true, 'once the store is back the owed write is confirmed');
  assert.deepEqual(h.store.persistCalls, [['agentkey', sha256(one.key)]]);
  h.store.persistCalls.length = 0;
  assert.equal(await h.auth.revokeAgentKey(user, two.kid), true);
  assert.deepEqual(h.store.persistCalls, [['agentkey', sha256(two.key)]]);
  assert.equal(h.auth.userForAgentKey(two.key), null);
  assert.deepEqual(h.auth.agentKeysInfo(user), []);
  let ok = true;
  const h2 = mkAuth(t, { persist: async () => ok });
  const u2 = h2.auth.userForSession((await login(h2)).token);
  const m2 = await h2.auth.mintAgentKey(u2, '');
  ok = false;
  assert.equal(await h2.auth.revokeAgentKey(u2, m2.kid), false);
});

// ---------- callback rate limit ----------
test('checkRate: 20 callbacks per address per 10 minutes, then AUTH_RATE until the window ends', T, async (t) => {
  const h = mkAuth(t);
  for (let i = 0; i < 20; i++) await h.checkRate('203.0.113.9');
  const e = await failure(h.checkRate('203.0.113.9'));
  assert.ok(e instanceof AuthError && e.code === 'AUTH_RATE');
  await assert.doesNotReject(() => h.checkRate('203.0.113.10'), 'another address has its own count');
  h.clock.t += 10 * 60 * 1000 - 1;
  await assert.rejects(() => h.checkRate('203.0.113.9'), AuthError);
  h.clock.t += 1;
  await assert.doesNotReject(() => h.checkRate('203.0.113.9'));
  assert.match(h.out.join(''), /event="auth\.login_failed" errorClass="AuthError" code="AUTH_RATE"/);
});

test('checkRate: an IPv6 /64 and an IPv4-mapped address share one count each', T, async (t) => {
  const h = mkAuth(t);
  for (let i = 0; i < 20; i++) await h.checkRate(`2001:db8:1:2:${i.toString(16)}::1`);
  await assert.rejects(() => h.checkRate('2001:db8:1:2:ffff::9'), AuthError);
  await assert.doesNotReject(() => h.checkRate('2001:db8:1:3::1'));
  for (let i = 0; i < 10; i++) await h.checkRate('198.51.100.7');
  for (let i = 0; i < 10; i++) await h.checkRate('::ffff:198.51.100.7');
  await assert.rejects(() => h.checkRate('198.51.100.7'), AuthError);
});

test('checkRate: the table holds 500 addresses; later ones share an overflow bucket per /24 with its own limit, and tracked ones keep theirs', T, async (t) => {
  const h = mkAuth(t);
  const ip = (i) => `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`;
  for (let i = 0; i < 500; i++) await h.checkRate(ip(i));
  // New addresses of one /24 share a bucket: 200 pass, the 201st does not, whoever it is. Another /24 has its own.
  const late = (i) => `172.16.5.${i % 250}`;
  for (let i = 0; i < 200; i++) await h.checkRate(late(i));
  await assert.rejects(() => h.checkRate('172.16.5.251'), (e) => e.code === 'AUTH_RATE');
  await assert.doesNotReject(() => h.checkRate('172.16.6.1'), 'another /24 is not affected');
  // A tracked address still has its own allowance.
  await assert.doesNotReject(() => h.checkRate(ip(3)));
  // When the windows are over the table frees up again.
  h.clock.t += 10 * 60 * 1000;
  await assert.doesNotReject(() => h.checkRate('172.16.5.251'));
});

test('checkRate: an unparseable address shares the key "invalid"', T, async (t) => {
  const h = mkAuth(t);
  for (let i = 0; i < 20; i++) await h.checkRate(['', 'garbage', undefined, null, 'x'.repeat(100)][i % 5]);
  await assert.rejects(() => h.checkRate('nonsense'), AuthError);
});

// ---------- config: BAD_SIGNIN at boot ----------
test('createApp and bootApp refuse SIGNIN=github without both GitHub secrets, before anything else is built', T, async (t) => {
  const dir = mkTmp('auth-boot-');
  t.after(() => rmTmp(dir));
  const config = cfg();
  const file = path.join(dir, 'data', 'rooms.json');
  for (const partial of [{}, { GITHUB_CLIENT_ID: 'id' }, { GITHUB_CLIENT_SECRET: 'sec' }]) {
    const s = loadSecrets(partial);
    assert.throws(() => createApp({ config, secrets: s, log: quietLog(), proxy: fakeProxy(), file }), (e) => e instanceof ConfigError && e.code === 'BAD_SIGNIN_SECRETS');
    await assert.rejects(bootApp({ config, secrets: s, log: quietLog(), proxy: fakeProxy(), file }), (e) => e instanceof ConfigError && e.code === 'BAD_SIGNIN_SECRETS');
  }
  assert.equal(fs.existsSync(path.dirname(file)), false, 'the store was never opened');
  const app = await bootApp({ config, secrets: secrets(), log: quietLog(), proxy: fakeProxy(), file });
  t.after(() => app.close());
  assert.ok(app.auth);
  const off = await bootApp({ config: loadConfig({ SIGNIN: 'off' }), secrets: loadSecrets({}), log: quietLog(), proxy: fakeProxy(), file: path.join(dir, 'off', 'rooms.json') });
  t.after(() => off.close());
  assert.equal(off.auth, null, 'no auth with sign-in off');
});

test('createHttpServer refuses sign-in without an auth object', () => {
  assert.throws(() => createHttpServer({ domain: { rooms: new Map(), onChange: () => () => {} }, info: { signin: 'github', signinOn: true, publicUrl: PUBLIC }, trustProxy: () => false }), TypeError);
});

// ---------- over HTTP ----------
const ORIGIN = PUBLIC;
const OAUTH = '__Host-behalf_oauth';
const SESSION = '__Host-behalf_session';

function request(base, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, cookies: res.headers['set-cookie'] || [], text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const cookieValue = (res, name) => {
  const line = res.cookies.find((c) => c.startsWith(name + '='));
  return line === undefined ? null : line.slice(name.length + 1).split(';')[0];
};

async function boot(t, { gh = fakeGithub(), signin = 'github', persist, extra, proxy } = {}) {
  const dir = mkTmp('auth-http-');
  const { out, log } = capture();
  const config = loadConfig({ SIGNIN: signin, DROP_DATA_DIR: path.join(dir, 'data'), PUBLIC_URL: PUBLIC, GITHUB_BLOCKED_IDS: '666', PER_IP_DAILY: '100', PER_USER_DAILY: '100', DAILY_ROOM_LIMIT: '100', ...extra });
  const base = createStore({ file: path.join(dir, 'data', 'rooms.json'), log });
  base.load();
  const store = wrapStore(base, { persist });
  const clock = mkClock(Date.now());
  const app = createApp({ config, secrets: secrets(), log, store, proxy: proxy || fakeProxy(), clock: { sleep: async () => {}, now: clock.now }, fetch: gh.fetch });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.drain().catch(() => {}); if (app.server.closeAllConnections) app.server.closeAllConnections(); app.close(); rmTmp(dir); });
  const h = { app, store, gh, out, clock, base: root, users: store.collection('user').map, sessions: store.collection('session').map, keys: store.collection('agentkey').map };
  h.req = (method, p, o) => request(root, method, p, o);
  // A JSON POST as the web page sends it, unless a test removes or changes a part.
  h.post = (p, { origin = ORIGIN, cookie, type = 'application/json', body = p === '/api/me/agent-key' ? { name: '' } : {}, headers = {} } = {}) => {
    const hd = { ...headers }; // (a key is made with a name, '' for none: a body without one is refused)
    if (origin !== null) hd.origin = origin;
    if (cookie) hd.cookie = cookie;
    if (type !== null) hd['content-type'] = type;
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    hd['content-length'] = Buffer.byteLength(payload);
    return h.req('POST', p, { headers: hd, body: payload });
  };
  return h;
}

// The browser's side: begin, follow GitHub (the fake), come back to the callback with the oauth cookie.
async function signIn(h, { next, code, headers = {} } = {}) {
  const begin = await h.req('GET', '/auth/github' + (next === undefined ? '' : '?next=' + encodeURIComponent(next)));
  const loc = new URL(begin.headers.location);
  h.gh.challenge = loc.searchParams.get('code_challenge');
  const oauth = cookieValue(begin, OAUTH);
  const cb = await h.req('GET', `/auth/github/callback?code=${code || h.gh.code}&state=${encodeURIComponent(loc.searchParams.get('state'))}`, { headers: { cookie: `${OAUTH}=${oauth}`, ...headers } });
  const session = cookieValue(cb, SESSION);
  return { begin, cb, oauth, session, cookie: `${SESSION}=${session}` };
}

const roomBody = { topic: 'Sign-in test', modeA: 'external', modeB: 'external' };

test('sign-in with next=/key is honoured end to end: the cookie carries /key and the callback returns there', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h, { next: '/key' });
  assert.match(decodeURIComponent(s.begin.cookies[0]), /[.]\/key; /);
  assert.equal(s.cb.status, 302);
  assert.equal(s.cb.headers.location, '/key');
});

test('GET /auth/github redirects to GitHub with the OAuth cookie: every attribute, and next is allowlisted', T, async (t) => {
  const h = await boot(t);
  const r = await h.req('GET', '/auth/github?next=/connect');
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  const state = new URL(r.headers.location).searchParams.get('state');
  assert.equal(r.cookies.length, 1);
  const m = /^__Host-behalf_oauth=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.(\/[a-z]*); (.*)$/.exec(r.cookies[0]);
  assert.ok(m, r.cookies[0]);
  assert.equal(m[1], state);
  assert.equal(m[3], '/connect');
  assert.equal(m[4], 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600');
  assert.ok(!/Domain/i.test(r.cookies[0]), 'a __Host- cookie has no Domain');
  assert.equal(r.headers['cache-control'], 'no-store');
  for (const bad of ['https://evil.test', '//evil.test', '/room/abc', '', '/start/']) {
    const x = await h.req('GET', '/auth/github' + (bad ? '?next=' + encodeURIComponent(bad) : ''));
    assert.ok(cookieValue(x, OAUTH).endsWith('./'), bad);
  }
  assert.equal(h.gh.calls.length, 0, 'beginning a login does not call GitHub');
});

test('the whole flow: sign in, /api/me, create a room, sign out', T, async (t) => {
  const h = await boot(t);
  // Signed out.
  const anon = await h.req('GET', '/api/me');
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.json, { user: null, signin: 'github', agentKeys: [], ai: 'none', admin: false });
  assert.equal((await h.req('GET', '/api/config')).json.signin, 'github');
  // Sign in.
  const s = await signIn(h, { next: '/start' });
  assert.equal(s.cb.status, 302);
  assert.equal(s.cb.headers.location, '/start');
  assert.equal(s.cb.cookies.length, 2);
  assert.equal(s.cb.cookies[0], `${SESSION}=${s.session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
  assert.equal(s.cb.cookies[1], `${OAUTH}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  assert.match(s.session, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([...h.sessions.keys()], [sha256(s.session)]);
  // /api/me.
  const me = await h.req('GET', '/api/me', { headers: { cookie: s.cookie } });
  assert.deepEqual(me.json, { user: { login: 'octocat' }, signin: 'github', agentKeys: [], ai: 'none', admin: false });
  // Create a live room: the user the domain gets is the session's, whatever the body says.
  const seen = [];
  const real = h.app.domain.createLiveRoom;
  h.app.domain.createLiveRoom = (ip, body, user) => { seen.push(user); return real(ip, body, user); };
  const made = await h.post('/api/rooms', { cookie: s.cookie, body: { ...roomBody, user: { id: 'forged', login: 'forged' }, userId: 'forged' } });
  assert.equal(made.status, 201, made.text);
  assert.ok(made.json.id);
  assert.deepEqual(seen, [{ id: '1001', login: 'octocat' }]);
  // Sign out.
  const out = await h.post('/auth/logout', { cookie: s.cookie });
  assert.equal(out.status, 204);
  assert.equal(out.cookies[0], `${SESSION}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  assert.deepEqual(h.store.persistCalls.filter((c) => c[0] === 'session'), [['session', sha256(s.session)]]);
  assert.deepEqual((await h.req('GET', '/api/me', { headers: { cookie: s.cookie } })).json, { user: null, signin: 'github', agentKeys: [], ai: 'none', admin: false });
  assert.equal((await h.post('/api/rooms', { cookie: s.cookie, body: roomBody })).status, 401);
  // Logging out again is fine and writes nothing.
  h.store.persistCalls.length = 0;
  assert.equal((await h.post('/auth/logout', { cookie: s.cookie })).status, 204);
  assert.deepEqual(h.store.persistCalls, []);
  // Nothing in the logs: no code, state, token, login, id or secret.
  const logged = h.out.join('');
  for (const secret of [GH_TOKEN, s.session, s.oauth, 'good-code', 'octocat', '1001', CLIENT_SECRET, CLIENT_ID]) assert.ok(!logged.includes(secret), 'logged: ' + secret);
  assert.match(logged, /event="auth\.login"/);
  assert.match(logged, /event="auth\.logout"/);
});

test('callback failures go back to /start?signin=failed and clear the OAuth cookie: no cookie, a wrong state, a bad code, a blocked id', T, async (t) => {
  const h = await boot(t);
  const failed = (r) => {
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/start?signin=failed');
    assert.deepEqual(r.cookies, [`${OAUTH}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`]);
    assert.equal(cookieValue(r, SESSION), null);
  };
  failed(await h.req('GET', '/auth/github/callback?code=good-code&state=x'));
  failed(await h.req('GET', '/auth/github/callback'));
  const b = await h.req('GET', '/auth/github');
  const state = new URL(b.headers.location).searchParams.get('state');
  const cookie = `${OAUTH}=${cookieValue(b, OAUTH)}`;
  failed(await h.req('GET', `/auth/github/callback?code=good-code&state=${state}x`, { headers: { cookie } }));
  failed(await h.req('GET', `/auth/github/callback?code=bad&state=${state}`, { headers: { cookie } }));
  failed(await h.req('GET', `/auth/github/callback?error=access_denied&state=${state}`, { headers: { cookie } }));
  failed(await h.req('GET', `/auth/github/callback?code=good-code&state=${state}`, { headers: { cookie: `${OAUTH}=${state}.onlytwo` } }));
  failed(await h.req('GET', `/auth/github/callback?code=good-code&state=${state}`, { headers: { cookie: `${OAUTH}=${cookieValue(b, OAUTH)}.extra` } }));
  h.gh.id = 666;
  const blocked = await signIn(h);
  failed(blocked.cb);
  assert.equal(h.sessions.size, 0);
  assert.equal(h.users.size, 0);
  const logged = h.out.join('');
  assert.match(logged, /code="AUTH_STATE"/);
  assert.match(logged, /code="AUTH_EXCHANGE"/);
  assert.match(logged, /code="AUTH_BLOCKED"/);
  assert.ok(!/GHTEXT|good-code/.test(logged));
});

test('the callback re-checks next: a tampered OAuth cookie cannot redirect off-site', T, async (t) => {
  const h = await boot(t);
  for (const evil of ['https://evil.test', '//evil.test', '/room/abc', 'javascript:alert(1)', '/start/..', '']) {
    const b = await h.req('GET', '/auth/github?next=/connect');
    const loc = new URL(b.headers.location);
    h.gh.challenge = loc.searchParams.get('code_challenge');
    const [state, verifier] = cookieValue(b, OAUTH).split('.');
    const r = await h.req('GET', `/auth/github/callback?code=good-code&state=${loc.searchParams.get('state')}`, { headers: { cookie: `${OAUTH}=${state}.${verifier}.${evil}` } });
    assert.equal(r.status, 302, evil);
    if (evil.includes('.')) {
      // A dot makes the cookie four parts, so it is refused outright: also safe.
      assert.equal(r.headers.location, '/start?signin=failed', evil);
      assert.equal(cookieValue(r, SESSION), null);
    } else {
      assert.equal(r.headers.location, '/', evil);
      assert.ok(cookieValue(r, SESSION), 'the login itself was valid');
    }
  }
});

test('a replayed callback fails: the code was spent, and the OAuth cookie was cleared', T, async (t) => {
  const h = await boot(t);
  const first = await signIn(h);
  assert.ok(first.session);
  h.gh.code = 'another-code'; // GitHub accepts a code once
  const again = await h.req('GET', `/auth/github/callback?code=good-code&state=whatever`, { headers: { cookie: first.cb.cookies[1].split(';')[0] } });
  assert.equal(again.headers.location, '/start?signin=failed');
});

test('only a callback that holds a state it was given counts: bare and forged ones never touch the limiter, 20 real attempts do', T, async (t) => {
  const h = await boot(t);
  for (let i = 0; i < 50; i++) await h.req('GET', '/auth/github/callback?code=x&state=y');
  for (let i = 0; i < 20; i++) await h.req('GET', `/auth/github/callback?code=x&state=y`, { headers: { cookie: `${OAUTH}=a.b./start` } });
  assert.ok(!h.out.join('').includes('AUTH_RATE'), 'nothing was counted yet');
  for (let i = 0; i < 18; i++) await signIn(h, { code: 'bad' }); // real attempts that fail at GitHub: counted
  const ok = await signIn(h); // the 19th real one
  assert.ok(ok.session, 'the 50 bare callbacks did not use up the allowance');
  const twentieth = await signIn(h);
  assert.ok(twentieth.session);
  const limited = await signIn(h); // the 21st
  assert.equal(limited.cb.headers.location, '/start?signin=failed');
  assert.equal(limited.session, null);
  assert.match(h.out.join(''), /code="AUTH_RATE"/);
  assert.equal(h.sessions.size, 2);
});

// ---------- the Origin, content type and session guards ----------
const GUARDED = [
  ['POST', '/api/rooms', roomBody],
  ['POST', '/api/me/agent-key', {}],
  ['POST', '/api/me/agent-key/revoke', {}],
  ['POST', '/auth/logout', {}],
];

test('Origin: missing, "null", another site, another scheme, another port and a lookalike are all 403, on every cookie-authenticated POST', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  for (const [, p, body] of GUARDED) {
    for (const origin of [null, 'null', 'https://evil.test', 'http://behalf.test', 'https://behalf.test:8443', 'https://behalf.test.evil.test', 'https://behalf.test/', 'https://BEHALF.TEST', '']) {
      const r = await h.post(p, { origin, cookie: s.cookie, body });
      assert.equal(r.status, 403, `${p} origin=${JSON.stringify(origin)}`);
      assert.match(r.json.error, /origin/i);
    }
  }
  assert.equal(h.sessions.size, 1, 'a refused logout did not log out');
  assert.equal(h.keys.size, 0);
  assert.equal(h.app.domain.rooms.size, 0);
});

test('Content-Type must be application/json (a charset is fine): anything else is 415, and the Origin is checked first', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  for (const [, p, body] of GUARDED) {
    for (const type of [null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'text/json', '']) {
      const r = await h.post(p, { cookie: s.cookie, type, body });
      assert.equal(r.status, 415, `${p} type=${JSON.stringify(type)}`);
    }
    assert.equal((await h.post(p, { cookie: s.cookie, type: 'text/plain', origin: null, body })).status, 403, 'the Origin comes first');
  }
  assert.equal((await h.post('/api/rooms', { cookie: s.cookie, type: 'application/json; charset=utf-8', body: roomBody })).status, 201);
  assert.equal((await h.post('/api/rooms', { cookie: s.cookie, type: 'Application/JSON', body: roomBody })).status, 201);
});

test('no session, or a dead one, is 401 on every cookie-authenticated POST, and nothing happens', T, async (t) => {
  const h = await boot(t);
  for (const [, p, body] of GUARDED) {
    if (p === '/auth/logout') continue; // logging out with no session is a no-op 204
    for (const cookie of [undefined, `${SESSION}=nope`, `${SESSION}=`, `${OAUTH}=x.y./`, 'other=1', `${SESSION}=${'x'.repeat(5000)}`]) {
      const r = await h.post(p, { cookie, body });
      assert.equal(r.status, 401, `${p} ${cookie}`);
    }
  }
  assert.equal(h.app.domain.rooms.size, 0);
  assert.equal(h.keys.size, 0);
});

test('the key routes refuse a request with no session before they read its body: a body that is not JSON is 401, not 400, and a valid body from a dead session is 401', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  for (const p of ['/api/me/agent-key', '/api/me/agent-key/revoke']) {
    for (const body of ['not json', '[', '{"name":"' + 'x'.repeat(10000) + '"}']) {
      const r = await h.post(p, { body });
      assert.equal(r.status, 401, p + ' ' + body.slice(0, 10));
      assert.equal(r.json.code, 'signin_required');
    }
    const bad = await h.post(p, { cookie: s.cookie, body: 'not json' });
    assert.equal(bad.status, 400, 'with a session the same body is the usual bad request');
  }
  assert.equal(h.keys.size, 0);
  const minted = await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'a' } });
  await h.post('/auth/logout', { cookie: s.cookie });
  assert.equal((await revokeKid(h, s, minted.json.kid)).status, 401, 'a dead session cannot revoke');
  assert.equal(h.keys.size, 1, 'and the key is untouched');
});

test('path spellings cannot skip the guard: /api//rooms, a trailing slash, a query string, repeated slashes', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  for (const p of ['/api/rooms', '/api//rooms', '/api/rooms/', '/api//rooms//', '/api/rooms?x=1', '/api/rooms/?x=1', '/api///rooms']) {
    assert.equal((await h.post(p, { origin: null, cookie: s.cookie, body: roomBody })).status, 403, p + ' without an Origin');
    assert.equal((await h.post(p, { type: 'text/plain', cookie: s.cookie, body: roomBody })).status, 415, p + ' with the wrong type');
    assert.equal((await h.post(p, { body: roomBody })).status, 401, p + ' without a session');
    assert.equal((await h.post(p, { cookie: s.cookie, body: roomBody })).status, 201, p + ' with everything');
  }
  for (const p of ['/api/me/agent-key/', '/api//me/agent-key', '/api//me//agent-key/']) {
    assert.equal((await h.post(p, { origin: null, cookie: s.cookie })).status, 403, p);
    assert.equal((await h.post(p, {})).status, 401, p);
  }
  assert.equal((await h.post('/api//me/agent-key/revoke/', { origin: null, cookie: s.cookie })).status, 403);
});

test('GET /api/me needs no Origin (it reads, and changes nothing); a GET cannot reach a POST route', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  assert.equal((await h.req('GET', '/api/me', { headers: { cookie: s.cookie } })).json.user.login, 'octocat');
  for (const p of ['/api/me/agent-key', '/api/me/agent-key/revoke', '/auth/logout']) {
    const r = await h.req('GET', p, { headers: { cookie: s.cookie } });
    assert.ok(r.status === 404, p + ' ' + r.status);
  }
  assert.equal(h.keys.size, 0);
  assert.equal(h.sessions.size, 1);
});

// ---------- agent keys over HTTP ----------
const meKeys = async (h, s) => (await h.req('GET', '/api/me', { headers: { cookie: s.cookie } })).json.agentKeys;
const revokeKid = (h, s, kid) => h.post('/api/me/agent-key/revoke', { cookie: s.cookie, body: { kid } });

test('POST /api/me/agent-key mints a named key once and replaces nothing; /api/me lists them by kid, newest first, with no secret', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const minted = await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'Claude Desktop' } });
  assert.equal(minted.status, 201);
  assert.deepEqual(Object.keys(minted.json).sort(), ['createdAt', 'key', 'kid', 'name']);
  assert.match(minted.json.key, /^bh_[A-Za-z0-9_-]{43}$/);
  assert.match(minted.json.kid, /^[0-9a-f]{12}$/);
  assert.equal(minted.json.name, 'Claude Desktop');
  h.clock.t += 1000;
  const me = await h.req('GET', '/api/me', { headers: { cookie: s.cookie } });
  assert.deepEqual(me.json, { user: { login: 'octocat' }, signin: 'github', agentKeys: [{ kid: minted.json.kid, name: 'Claude Desktop', createdAt: minted.json.createdAt, lastUsedAt: null }], ai: 'none', admin: false });
  assert.ok(!me.text.includes(minted.json.key));
  assert.deepEqual(h.app.auth.userForAgentKey(minted.json.key), { id: '1001', login: 'octocat' });
  h.clock.t += 1000;
  const unnamed = await h.post('/api/me/agent-key', { cookie: s.cookie });
  assert.equal(unnamed.status, 201);
  assert.equal(unnamed.json.name, null);
  assert.notEqual(unnamed.json.key, minted.json.key);
  assert.notEqual(unnamed.json.kid, minted.json.kid);
  assert.ok(h.app.auth.userForAgentKey(minted.json.key), 'the first key still works: a new key replaces nothing');
  assert.ok(h.app.auth.userForAgentKey(unnamed.json.key));
  assert.deepEqual((await meKeys(h, s)).map((k) => k.kid), [unnamed.json.kid, minted.json.kid], 'newest first');
  const gone = await revokeKid(h, s, unnamed.json.kid);
  assert.equal(gone.status, 204);
  assert.equal(gone.text, '');
  assert.equal(h.app.auth.userForAgentKey(unnamed.json.key), null);
  assert.ok(h.app.auth.userForAgentKey(minted.json.key), 'deleting one key leaves the other');
  assert.deepEqual((await meKeys(h, s)).map((k) => k.kid), [minted.json.kid]);
  assert.equal((await revokeKid(h, s, unnamed.json.kid)).status, 204, 'deleting a key that is already gone is fine');
  const logged = h.out.join('');
  for (const k of [minted.json.key, unnamed.json.key]) assert.ok(!logged.includes(k));
  assert.ok(!logged.includes('Claude Desktop'), 'a key name is never logged');
});

test('a key record from before names whose lastUsedAt is its creation time reads as not yet used: its first use is saved at once, unlike a record with a name', T, async (t) => {
  const h = mkAuth(t);
  const user = h.auth.userForSession((await login(h)).token);
  const t0 = h.clock.t;
  const legacy = 'bh_legacy-from-before-names';
  const named = 'bh_named-and-unused-so-far';
  h.keys.set(sha256(legacy), { userId: String(user.id), createdAt: t0 - 1000, lastUsedAt: t0 - 1000 });
  h.keys.set(sha256(named), { userId: String(user.id), name: null, createdAt: t0, lastUsedAt: t0 });
  const { auth, saves } = spiedAuth(h);
  assert.deepEqual(auth.agentKeysInfo(user).map((k) => k.lastUsedAt), [t0, null], 'newest first; only the record without a name reads as unused');
  h.clock.t = t0 + HOUR;
  assert.ok(auth.userForAgentKey(legacy));
  assert.deepEqual(saves, [sha256(legacy)], 'the first use of the old record is saved within the day');
  assert.ok(auth.userForAgentKey(named));
  assert.deepEqual(saves, [sha256(legacy)], 'a record with a name and a used time is saved only daily');
});

test('the key routes: a missing name is a 400 with no code; a bad or taken name a 400 with its code and a fixed sentence; a missing or malformed kid a 400 with no code; the 11th live key is 409 key_limit', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const AV = require('../web/js/account-view.js');
  const stale = await h.post('/api/me/agent-key', { cookie: s.cookie, body: {} });
  assert.equal(stale.status, 400, 'a page from before names sends no name: it must not mint');
  assert.deepEqual(Object.keys(stale.json), ['error'], 'no machine code');
  assert.equal(h.keys.size, 0, 'and nothing was minted');
  assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: { other: 'x' } })).status, 400);
  assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: [] })).status, 400, 'the body must be an object');
  assert.equal(h.keys.size, 0);
  for (const name of ['x'.repeat(41), 7, null, ['a'], { a: 1 }, '\u{D800}']) {
    const r = await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name } });
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.equal(r.json.code, 'key_name');
    assert.equal(r.json.error, 'A key name is at most 40 characters.', 'a fixed sentence that does not echo the name');
    assert.notEqual(AV.errorMessage('keyCreate', 400, 'key_name'), AV.errorMessage('keyCreate', 400), 'the page words it itself');
  }
  assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: '\u{202E}\u0007' } })).json.name, null, 'a name that cleans to nothing is no name');
  assert.equal(h.keys.size, 1);
  const named = await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'Claude Code' } });
  assert.equal(named.status, 201);
  const taken = await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: ' claude code' } });
  assert.equal(taken.status, 400);
  assert.deepEqual(taken.json, { error: 'A key with that name already exists.', code: 'key_name_taken' });
  assert.equal(h.keys.size, 2);
  for (const body of [{}, { kid: 7 }, { kid: null }, { kid: '' }, { kid: 'ABCDEF012345' }, { kid: 'abcdef01234' }, { kid: 'abcdef0123456' }, { kid: 'abcdef01234g' }, { kid: ['abcdef012345'] }, { kid: 'abcdef012345\n' }]) {
    const r = await h.post('/api/me/agent-key/revoke', { cookie: s.cookie, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(Object.keys(r.json), ['error'], 'no machine code');
  }
  assert.equal(h.keys.size, 2, 'a bad request revoked nothing');
  for (let i = 2; i < 10; i++) assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'App ' + i } })).status, 201, 'mint ' + i);
  const over = await h.post('/api/me/agent-key', { cookie: s.cookie });
  assert.equal(over.status, 409);
  assert.equal(over.json.code, 'key_limit');
  assert.equal(h.keys.size, 10);
});

test('a refused key request (bad name, taken name, no name, the limit) does not use up the mint allowance of 10 per 10 minutes', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const first = await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'Claude Code' } });
  assert.equal(first.status, 201);
  for (let i = 0; i < 15; i++) {
    assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'x'.repeat(41) } })).json.code, 'key_name');
    assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'CLAUDE CODE' } })).json.code, 'key_name_taken');
    assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: {} })).status, 400);
  }
  for (let i = 1; i < 10; i++) assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'App ' + i } })).status, 201, 'mint ' + i + ': the allowance is intact');
  assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'One more' } })).json.code, 'key_limit', 'the limit is checked before the rate');
  for (let i = 0; i < 5; i++) assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'One more' } })).status, 409, 'and a refusal still uses none');
  assert.equal((await revokeKid(h, s, first.json.kid)).status, 204);
  assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'One more' } })).status, 429, 'the tenth mint was the last one allowed');
});

test('a user at the key limit with one idle key can create a key: the route counts only the live ones, and the idle one is dropped', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const made = [];
  for (let i = 0; i < 10; i++) made.push(await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'App ' + i } }));
  assert.ok(made.every((r) => r.status === 201));
  assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'Over' } })).json.code, 'key_limit', 'ten live keys is the limit');
  const idle = h.keys.get(sha256(made[3].json.key));
  idle.createdAt -= 91 * DAY; // never used and made 91 days ago: idle, the others are not
  h.clock.t += 11 * 60 * 1000; // past the mint rate window (ten mints used it up)
  const r = await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'Fresh' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(h.keys.has(sha256(made[3].json.key)), false, 'the idle key was dropped');
  assert.equal(h.keys.size, 10);
});

test('mint, revoke and logout answer 503 with the saving_unavailable code when the store is failing or the write fails; a revocation still takes effect in memory', T, async (t) => {
  const SAVING = { error: 'Saving is unavailable right now. Try again in a minute.', code: 'saving_unavailable' };
  const h = await boot(t);
  const s = await signIn(h);
  const minted = await h.post('/api/me/agent-key', { cookie: s.cookie });
  h.store.failing = true;
  h.store.persistCalls.length = 0;
  const mint = await h.post('/api/me/agent-key', { cookie: s.cookie });
  assert.equal(mint.status, 503);
  assert.deepEqual(mint.json, SAVING);
  assert.ok(h.app.auth.userForAgentKey(minted.json.key), 'a refused mint changed nothing');
  const revoke = await revokeKid(h, s, minted.json.kid);
  assert.equal(revoke.status, 503);
  assert.deepEqual(revoke.json, SAVING);
  assert.equal(h.app.auth.userForAgentKey(minted.json.key), null, 'the revoke took effect in memory');
  const retried = await revokeKid(h, s, minted.json.kid);
  assert.equal(retried.status, 503, 'a retry while saving is still failing is not "deleted"');
  assert.deepEqual(retried.json, SAVING);
  const out = await h.post('/auth/logout', { cookie: s.cookie });
  assert.equal(out.status, 503);
  assert.deepEqual(out.json, SAVING);
  assert.equal(out.cookies[0], `${SESSION}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`, 'the cookie is cleared even so');
  assert.equal(h.app.auth.userForSession(s.session), null, 'and the session is gone in memory');
  assert.deepEqual(h.store.persistCalls, [], 'nothing was written to a failing store');
  // A write that fails (the store itself says nothing is wrong): the same answers.
  const h2 = await boot(t, { persist: async () => false });
  const s2 = await signIn(h2);
  assert.equal((await h2.post('/api/me/agent-key', { cookie: s2.cookie })).status, 503);
  assert.equal(h2.keys.size, 0);
  assert.equal((await h2.post('/auth/logout', { cookie: s2.cookie })).status, 503);
});

// ---------- /mcp ----------
test('/mcp never reads cookies: the same request with and without a session cookie gets the same answer', T, async (t) => {
  assert.ok(!/cookie/i.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp.js'), 'utf8')), 'lib/mcp.js mentions cookies');
  const h = await boot(t);
  const s = await signIn(h);
  const call = (id, name, args) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const send = (cookie, payload, key) => h.req('POST', '/mcp', { headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(cookie ? { cookie } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: payload });
  const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const a = await send(null, list);
  const b = await send(s.cookie, list);
  assert.equal(a.status, 200);
  assert.deepEqual([b.status, b.text], [a.status, a.text]);
  const make = call(2, 'create_room', { topic: 'cookie test' });
  // With sign-in on, create_room needs the agent key: a session cookie changes nothing, with or without the key.
  const refusedWith = await send(s.cookie, make);
  const refusedWithout = await send(null, make);
  assert.deepEqual([refusedWith.status, refusedWith.text], [refusedWithout.status, refusedWithout.text]);
  assert.equal(refusedWith.json.result.isError, true);
  assert.equal(h.app.domain.rooms.size, 0);
  const key = (await h.post('/api/me/agent-key', { cookie: s.cookie })).json.key;
  const withCookie = await send(s.cookie, make, key);
  const without = await send(null, make, key);
  assert.equal(withCookie.status, without.status);
  // The random parts (the room id, the seat tokens) masked: what is left is the shape of the answer.
  const strip = (r) => JSON.stringify(r.json).split(JSON.parse(r.json.result.content[0].text).room_id).join('ID').replace(/t=[A-Za-z0-9_-]+/g, 't=T');
  assert.equal(strip(withCookie), strip(without));
  // The owner is the key's user, whatever else the request carried.
  assert.equal(h.app.domain.rooms.size, 2);
  for (const room of h.app.domain.rooms.values()) assert.equal(room.ownerId, '1001');
});

// ---------- SIGNIN=off ----------
test('SIGNIN=off: the auth routes and the agent-key routes are unknown routes, /api/me says off, and room creation is as before', T, async (t) => {
  const h = await boot(t, { signin: 'off' });
  // The same answer as a route that never existed.
  const same = async (method, p, unknown) => {
    const a = method === 'GET' ? await h.req('GET', p) : await h.post(p, { origin: null, type: null });
    const b = method === 'GET' ? await h.req('GET', unknown) : await h.post(unknown, { origin: null, type: null });
    assert.deepEqual([a.status, a.text, a.headers['content-type']], [b.status, b.text, b.headers['content-type']], `${method} ${p}`);
    assert.equal(a.status, 404, `${method} ${p}`);
    assert.deepEqual(a.cookies, []);
  };
  await same('GET', '/auth/github', '/auth/zzz');
  await same('GET', '/auth/github?next=/connect', '/auth/zzz');
  await same('GET', '/auth/github/callback', '/auth/zzz');
  await same('POST', '/auth/logout', '/auth/zzz');
  await same('POST', '/api/me/agent-key', '/api/me/zzz');
  await same('POST', '/api/me/agent-key/revoke', '/api/me/zzz');
  assert.deepEqual((await h.req('GET', '/api/me')).json, { user: null, signin: 'off', agentKeys: [], ai: 'none', admin: false });
  assert.deepEqual((await h.req('GET', '/api/me', { headers: { cookie: `${SESSION}=anything` } })).json, { user: null, signin: 'off', agentKeys: [], ai: 'none', admin: false });
  assert.equal((await h.req('GET', '/api/config')).json.signin, 'off');
  // POST /api/rooms: no Origin, no content type, no cookie needed, and the domain is given no user.
  const seen = [];
  const real = h.app.domain.createLiveRoom;
  h.app.domain.createLiveRoom = (ip, body, user) => { seen.push(user); return real(ip, body, user); };
  const made = await h.post('/api/rooms', { origin: null, type: null, body: roomBody });
  assert.equal(made.status, 201, made.text);
  assert.equal((await h.post('/api/rooms', { origin: 'https://evil.test', cookie: `${SESSION}=x`, body: roomBody })).status, 201);
  assert.deepEqual(seen, [undefined, undefined]);
  assert.equal(h.app.auth, null);
});

test('with SIGNIN=github the page and API routes that are not about sign-in are unchanged: static pages, /health, an unknown /auth path is 404', T, async (t) => {
  const h = await boot(t);
  assert.equal((await h.req('GET', '/')).status, 200);
  assert.equal((await h.req('GET', '/health')).status, 200);
  assert.equal((await h.req('GET', '/auth/unknown')).status, 404);
  assert.equal((await h.req('GET', '/auth/')).status, 404);
  assert.equal((await h.req('POST', '/auth/github')).status, 404);
  assert.equal((await h.req('GET', '/auth/logout')).status, 404);
  const demo = await h.post('/api/demo', { origin: null, type: null });
  assert.equal(demo.status, 201, 'the demo stays open: no sign-in, no Origin');
  const room = await h.req('GET', `/api/rooms/${demo.json.id}`);
  assert.equal(room.status, 200, 'room reads stay open');
  const seat = await h.post(`/api/rooms/${demo.json.id}/seats/A/draft`, { origin: null, type: null, body: { token: 'wrong' } });
  assert.equal(seat.status, 403, 'seat actions are still decided by the seat token, not the session');
});

test('createApp sweeps expired sessions with the room sweep (at start, then hourly)', T, async (t) => {
  const dir = mkTmp('auth-sweep-');
  const { log } = capture();
  const store = createStore({ file: path.join(dir, 'rooms.json'), log });
  store.load();
  const sessions = store.collection('session').map;
  const now = Date.now();
  sessions.set('expired', { userId: '1', createdAt: now - 40 * DAY, expiresAt: now - DAY, lastSeenAt: now - 2 * DAY });
  sessions.set('live', { userId: '1', createdAt: now, expiresAt: now + DAY, lastSeenAt: now });
  const app = createApp({ config: cfg(), secrets: secrets(), log, store, proxy: fakeProxy(), clock: { sleep: async () => {} } });
  t.after(() => { app.close(); rmTmp(dir); });
  assert.deepEqual([...sessions.keys()], ['live']);
});

// ---------- Gate 2 fixes ----------

test('a blocked id is blocked everywhere: its existing sessions and keys stop resolving at once, minting is refused, and sweep removes them', T, async (t) => {
  const h = mkAuth(t);
  const { token } = await login(h);
  const user = h.auth.userForSession(token);
  const { key } = await h.auth.mintAgentKey(user, '');
  // The same store, now with the id on the block list (a restart with GITHUB_BLOCKED_IDS set).
  const blocked = createAuth({ store: h.store, canRevoke: canRevokeOf(h.store), config: cfg({ GITHUB_BLOCKED_IDS: '1001' }), secrets: secrets(), fetch: h.gh.fetch, clock: h.clock, log: quietLog() });
  assert.ok(h.auth.userForSession(token) && h.auth.userForAgentKey(key), 'unblocked, both resolve (so the block is the cause)');
  assert.equal(blocked.userForSession(token), null);
  assert.equal(blocked.userForAgentKey(key), null);
  const writes = h.store.persistCalls.length;
  assert.deepEqual(await blocked.mintAgentKey(user, ''), { ok: false, reason: 'saving' }, 'minting is refused');
  assert.equal(h.store.persistCalls.length, writes, 'and nothing was written for it');
  assert.equal(h.keys.size + h.sessions.size, 2, 'refusing does not delete');
  blocked.sweep();
  assert.equal(h.sessions.size, 0);
  assert.equal(h.keys.size, 0);
  assert.equal(h.users.size, 1, 'the user record stays');
  // Another user is not touched.
  h.gh.id = 1002; h.gh.login = 'other';
  const other = (await login(h)).token;
  blocked.sweep();
  assert.ok(blocked.userForSession(other));
});

test('the per-user limiter allows 10 per 10 minutes per user and is its own count per user', () => {
  let t = 1000;
  const store = { collection: () => ({ map: new Map(), save() {} }), health: () => ({ failingSince: null }), persist: async () => true };
  const a = createAuth({ store, canRevoke: () => true, config: cfg(), secrets: secrets(), clock: { now: () => t }, log: quietLog() });
  for (let i = 0; i < 10; i++) assert.equal(a.userRateOk('1'), true);
  assert.equal(a.userRateOk('1'), false);
  assert.equal(a.userRateOk('2'), true);
  t += 10 * 60 * 1000 - 1;
  assert.equal(a.userRateOk('1'), false);
  t += 1;
  assert.equal(a.userRateOk('1'), true);
});

test('only minting is rate-limited: the mint after 10 in 10 minutes is 429 with a fixed sentence, and logout and revoke still work', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const kids = [];
  for (let i = 0; i < 10; i++) { const r = await h.post('/api/me/agent-key', { cookie: s.cookie }); assert.equal(r.status, 201, 'mint ' + i); kids.push(r.json.kid); }
  assert.equal((await revokeKid(h, s, kids[0])).status, 204, 'room for one more key');
  const minted = await h.post('/api/me/agent-key', { cookie: s.cookie });
  assert.equal(minted.status, 429);
  assert.deepEqual(minted.json, { error: 'Too many requests. Try again in a few minutes.', code: 'rate_limited' });
  assert.equal(h.keys.size, 9, 'the refused mint changed nothing');
  for (const kid of [...kids.slice(1), ...kids.slice(0, 2)]) assert.equal((await revokeKid(h, s, kid)).status, 204, 'revoke ' + kid);
  assert.equal(h.keys.size, 0);
  assert.equal((await h.post('/auth/logout', { cookie: s.cookie })).status, 204);
  assert.equal(h.app.auth.userForSession(s.session), null);
  // Another user has their own count.
  h.gh.id = 2002; h.gh.login = 'other';
  const s2 = await signIn(h);
  assert.equal((await h.post('/api/me/agent-key', { cookie: s2.cookie })).status, 201);
});

test('the per-user limiter, with its table full, counts further users in one overflow bucket of 200', () => {
  let t = 1000;
  const store = { collection: () => ({ map: new Map(), save() {} }), health: () => ({ failingSince: null }), persist: async () => true };
  const a = createAuth({ store, canRevoke: () => true, config: cfg(), secrets: secrets(), clock: { now: () => t }, log: quietLog() });
  for (let i = 0; i < 2000; i++) assert.equal(a.userRateOk('u' + i), true);
  for (let i = 0; i < 200; i++) assert.equal(a.userRateOk('late' + i), true);
  assert.equal(a.userRateOk('late-one-more'), false);
  assert.equal(a.userRateOk('u5'), true, 'a tracked user keeps their own count');
});

test('rateKey: IPv4 as is, an IPv4-mapped IPv6 address as the IPv4, other IPv6 as its /64, anything else "invalid"', () => {
  const { rateKey } = require('../lib/net');
  assert.equal(rateKey('203.0.113.9'), '203.0.113.9');
  assert.equal(rateKey(' 203.0.113.9 '), '203.0.113.9');
  assert.equal(rateKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(rateKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:0db8:0001:0002');
  assert.equal(rateKey('2001:db8:1:2::1'), rateKey('2001:db8:1:2:ffff::2'));
  for (const bad of ['', 'nope', undefined, null, 'x'.repeat(100), '999.1.1.1']) assert.equal(rateKey(bad), 'invalid', String(bad));
});

test('checkRate: past the table cap an IPv6 address is counted per /48 and IPv4 in one bucket; a refusal is logged once per bucket and window', T, async (t) => {
  const h = mkAuth(t);
  const v4 = (i) => `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`;
  for (let i = 0; i < 500; i++) await h.checkRate(v4(i));
  // Two /64s of one /48 share a bucket of 200; a /64 of another /48 has its own.
  for (let i = 0; i < 200; i++) await h.checkRate(`2001:db8:aaaa:${(i % 2).toString(16)}::${(i + 1).toString(16)}`);
  const refused = async () => { try { await h.checkRate('2001:db8:aaaa:7::1'); return false; } catch (e) { return e.code === 'AUTH_RATE'; } };
  assert.equal(await refused(), true);
  await assert.doesNotReject(() => h.checkRate('2001:db8:bbbb:1::1'), 'another /48 is not affected');
  await assert.doesNotReject(() => h.checkRate('10.9.9.9'), 'nor the IPv4 bucket');
  for (let i = 0; i < 5; i++) assert.equal(await refused(), true);
  const lines = () => h.out.join('').split('\n').filter((l) => l.includes('code="AUTH_RATE"')).length;
  assert.equal(lines(), 1, 'six refusals, one line');
  h.clock.t += 10 * 60 * 1000;
  for (let i = 0; i < 201; i++) await refused();
  assert.equal(lines(), 2, 'a new window logs again');
});

test('checkRate: an address inside the table logs its first refusal only, once per window', T, async (t) => {
  const h = mkAuth(t);
  for (let i = 0; i < 20; i++) await h.checkRate('203.0.113.9');
  for (let i = 0; i < 6; i++) await assert.rejects(() => h.checkRate('203.0.113.9'), AuthError);
  assert.equal(h.out.join('').split('\n').filter((l) => l.includes('code="AUTH_RATE"')).length, 1);
});

test('GitHub is never followed through a redirect: both calls say redirect error', T, async (t) => {
  const h = mkAuth(t);
  await login(h);
  assert.deepEqual(h.gh.calls.map((c) => c.init.redirect), ['error', 'error']);
});

test('an OAuth state works once: a replay of the same callback is AUTH_STATE even with the right code', T, async (t) => {
  const h = mkAuth(t);
  const b = h.auth.beginLogin();
  h.gh.challenge = new URL(b.location).searchParams.get('code_challenge');
  const args = { code: 'good-code', state: b.state, expected: b };
  assert.ok((await h.auth.completeLogin(args)).token);
  assert.equal((await failure(h.auth.completeLogin(args))).code, 'AUTH_STATE');
  assert.equal(h.gh.calls.length, 2, 'GitHub was not called again');
  assert.equal(h.sessions.size, 1);
  // A state that failed at GitHub is spent too.
  const b2 = h.auth.beginLogin();
  const bad = { code: 'wrong', state: b2.state, expected: b2 };
  assert.equal((await failure(h.auth.completeLogin(bad))).code, 'AUTH_EXCHANGE');
  assert.equal((await failure(h.auth.completeLogin(bad))).code, 'AUTH_STATE');
  // The memory of a used state ends with the 10 minutes a login can take.
  h.clock.t += 10 * 60 * 1000;
  assert.equal((await failure(h.auth.completeLogin(bad))).code, 'AUTH_EXCHANGE');
});

test('the table of used states is bounded: past its cap the oldest is forgotten, not the newest', T, async (t) => {
  const h = mkAuth(t);
  const first = h.auth.beginLogin();
  await failure(h.auth.completeLogin({ code: '', state: first.state, expected: first }));
  // (spread over 100 addresses of 20 each, so the callback limiter has nothing to say)
  for (let i = 0; i < 2000; i++) { const b = h.auth.beginLogin(); await failure(h.auth.completeLogin({ code: '', state: b.state, expected: b, ip: `10.0.${i % 100}.1` })); }
  const last = h.auth.beginLogin();
  await failure(h.auth.completeLogin({ code: '', state: last.state, expected: last }));
  assert.equal((await failure(h.auth.completeLogin({ code: '', state: last.state, expected: last }))).code, 'AUTH_STATE', 'the newest is still remembered');
  assert.equal((await failure(h.auth.completeLogin({ code: '', state: first.state, expected: first }))).code, 'AUTH_EXCHANGE', 'the oldest was dropped to make room');
});

test('the table of used states makes room by forgetting the oldest one only, not all of them', T, async (t) => {
  const h = mkAuth(t);
  const all = [];
  for (let i = 0; i < 2000; i++) {
    const b = h.auth.beginLogin();
    all.push(b);
    await failure(h.auth.completeLogin({ code: '', state: b.state, expected: b, ip: `10.0.${i % 100}.1` }));
  }
  const extra = h.auth.beginLogin();
  await failure(h.auth.completeLogin({ code: '', state: extra.state, expected: extra, ip: '10.1.0.1' })); // the 2001st: one is forgotten
  const code = async (b, ip) => (await failure(h.auth.completeLogin({ code: '', state: b.state, expected: b, ip }))).code;
  assert.equal(await code(all[1999], '10.2.0.1'), 'AUTH_STATE', 'the newest of the old ones is still remembered');
  assert.equal(await code(all[1000], '10.2.0.2'), 'AUTH_STATE', 'so is one from the middle');
  assert.equal(await code(all[0], '10.2.0.3'), 'AUTH_EXCHANGE', 'only the oldest went');
});

test('a login that arrives with a session ends that session, and only that one', T, async (t) => {
  const h = mkAuth(t);
  const a = (await login(h)).token;
  const other = (await login(h)).token;
  const b = h.auth.beginLogin();
  h.gh.challenge = new URL(b.location).searchParams.get('code_challenge');
  const fresh = await h.auth.completeLogin({ code: 'good-code', state: b.state, expected: b, previousToken: a });
  assert.equal(h.auth.userForSession(a), null, 'the session the request carried is ended');
  assert.ok(h.auth.userForSession(other), 'another session of the same user is not');
  assert.ok(h.auth.userForSession(fresh.token));
  for (const junk of [undefined, null, '', 'unknown', 7, 'x'.repeat(300)]) {
    const c = h.auth.beginLogin();
    h.gh.challenge = new URL(c.location).searchParams.get('code_challenge');
    await h.auth.completeLogin({ code: 'good-code', state: c.state, expected: c, previousToken: junk });
  }
});

test('over HTTP: a callback that carries the old session cookie ends it', T, async (t) => {
  const h = await boot(t);
  const first = await signIn(h);
  const begin = await h.req('GET', '/auth/github');
  const loc = new URL(begin.headers.location);
  h.gh.challenge = loc.searchParams.get('code_challenge');
  const cb = await h.req('GET', `/auth/github/callback?code=good-code&state=${loc.searchParams.get('state')}`, { headers: { cookie: `${OAUTH}=${cookieValue(begin, OAUTH)}; ${first.cookie}` } });
  const second = cookieValue(cb, SESSION);
  assert.ok(second && second !== first.session);
  assert.equal(h.app.auth.userForSession(first.session), null);
  assert.ok(h.app.auth.userForSession(second));
});

test('a sign-in cookie that appears twice, or only matches after trimming its name, counts as absent', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const who = async (cookie) => (await h.req('GET', '/api/me', { headers: { cookie } })).json.user;
  assert.equal((await who(s.cookie)).login, 'octocat');
  assert.equal((await who(`other=1; ${s.cookie}; more=2`)).login, 'octocat', 'a normal header with neighbours');
  assert.equal((await who(`${s.cookie};${SESSION}=other`)), null, 'twice, the good one first');
  assert.equal((await who(`${SESSION}=other; ${s.cookie}`)), null, 'twice, the good one last');
  assert.equal((await who(`${s.cookie}; ${s.cookie}`)), null, 'twice, the same value');
  assert.equal((await who(`${SESSION} =${s.session}`)), null, 'a padded name');
  assert.equal((await who(`${SESSION}\t=${s.session}`)), null, 'a name padded with a tab');
  assert.equal((await who(`x${SESSION}=${s.session}`)), null, 'another name');
  assert.equal((await who(`${SESSION.toLowerCase()}=${s.session}`)), null, 'another case');
  // The same rule for the OAuth cookie.
  const begin = await h.req('GET', '/auth/github');
  const loc = new URL(begin.headers.location);
  h.gh.challenge = loc.searchParams.get('code_challenge');
  const o = `${OAUTH}=${cookieValue(begin, OAUTH)}`;
  const cb = await h.req('GET', `/auth/github/callback?code=good-code&state=${loc.searchParams.get('state')}`, { headers: { cookie: `${o}; ${o}` } });
  assert.equal(cb.headers.location, '/start?signin=failed');
  // A POST guarded by the session cookie sees the same.
  assert.equal((await h.post('/api/me/agent-key', { cookie: `${s.cookie}; ${SESSION}=x` })).status, 401);
});

test('agent keys expire after 90 days unused, lastUsedAt moves on every use but is saved on the first use and then daily, and a key without lastUsedAt counts from its creation', T, async (t) => {
  const h = mkAuth(t);
  const user = h.auth.userForSession((await login(h)).token);
  const { key } = await h.auth.mintAgentKey(user, '');
  const id = sha256(key);
  const t0 = h.clock.t;
  assert.equal(h.keys.get(id).lastUsedAt, null, 'never used');
  const { auth: a, saves } = spiedAuth(h);
  saves.length = 0;
  h.clock.t = t0 + 1000;
  assert.ok(a.userForAgentKey(key));
  assert.equal(h.keys.get(id).lastUsedAt, t0 + 1000);
  assert.deepEqual(saves, [id], 'the first use is saved at once');
  h.clock.t = t0 + 1000 + DAY - 1;
  assert.ok(a.userForAgentKey(key));
  assert.equal(h.keys.get(id).lastUsedAt, t0 + 1000 + DAY - 1, 'in memory every use counts');
  assert.equal(a.agentKeysInfo(user)[0].lastUsedAt, t0 + 1000 + DAY - 1);
  assert.equal(saves.length, 1, 'but it is not saved again within the day');
  h.clock.t = t0 + 1000 + DAY;
  assert.ok(a.userForAgentKey(key));
  assert.equal(saves.length, 2, 'a day after the last save, it is saved');
  h.clock.t += DAY - 1;
  assert.ok(a.userForAgentKey(key));
  assert.equal(saves.length, 2, 'the day is counted from the last save, not from the last use');
  // Used every 60 days it lives past 90 days from creation.
  for (const d of [60, 120, 180]) { h.clock.t = t0 + d * DAY; assert.ok(a.userForAgentKey(key), 'day ' + d); }
  h.clock.t = t0 + 180 * DAY + 90 * DAY - 1;
  assert.ok(a.userForAgentKey(key));
  h.clock.t += 90 * DAY;
  assert.equal(a.userForAgentKey(key), null);
  assert.equal(h.keys.has(id), false, 'an idle key is deleted');
  assert.deepEqual(a.agentKeysInfo(user), []);
  // A restart: the time of the last save is not stored, so the stored lastUsedAt stands in for it.
  const { key: k2 } = await a.mintAgentKey(user, '');
  h.clock.t += 1000;
  assert.ok(a.userForAgentKey(k2));
  const restarted = spiedAuth(h);
  restarted.saves.length = 0;
  h.clock.t += DAY - 1;
  assert.ok(restarted.auth.userForAgentKey(k2));
  assert.equal(restarted.saves.length, 0);
  h.clock.t += 1;
  assert.ok(restarted.auth.userForAgentKey(k2));
  assert.equal(restarted.saves.length, 1);
  // A record from before lastUsedAt existed.
  const legacy = 'bh_legacy-key';
  h.keys.set(sha256(legacy), { userId: '1001', createdAt: h.clock.t - 89 * DAY });
  const again = createAuth({ store: h.store, canRevoke: canRevokeOf(h.store), config: cfg(), secrets: secrets(), fetch: h.gh.fetch, clock: h.clock, log: quietLog() });
  assert.ok(again.userForAgentKey(legacy), 'created 89 days ago');
  h.clock.t += 2 * DAY;
  delete h.keys.get(sha256(legacy)).lastUsedAt;
  assert.equal(again.userForAgentKey(legacy), null, 'a legacy key is idle from its creation');
});

test('a mint whose write fails forgets its key: a later revoke of that kid has nothing owed to wait for', T, async (t) => {
  let ok = false;
  const h = mkAuth(t, { persist: async () => ok });
  const user = h.auth.userForSession((await login(h)).token);
  assert.deepEqual(await h.auth.mintAgentKey(user, ''), { ok: false, reason: 'saving' });
  const id = h.store.persistCalls[0][1];
  assert.equal(h.keys.size, 0);
  h.store.persistCalls.length = 0;
  ok = true;
  assert.equal(await h.auth.revokeAgentKey(user, kidOf(id)), true);
  assert.deepEqual(h.store.persistCalls, [], 'no write is waited for: the key was never kept');
});

test('the indexes are built from what the store loaded: the session cap counts loaded sessions, and a user\'s keys are all kept, each with a derived kid', T, async (t) => {
  const h = mkAuth(t);
  const now = h.clock.t;
  h.users.set('1001', { id: '1001', login: 'octocat', createdAt: now, lastLoginAt: now });
  for (let i = 0; i < 10; i++) h.sessions.set('old-session-' + i, { userId: '1001', createdAt: now - (20 - i) * 1000, expiresAt: now + DAY, lastSeenAt: now });
  h.keys.set('key-old', { userId: '1001', name: null, createdAt: now - 5000, lastUsedAt: now });
  h.keys.set('key-new', { userId: '1001', name: 'Claude Code', createdAt: now - 1000, lastUsedAt: now });
  h.keys.set('key-other', { userId: '2002', name: null, createdAt: now - 1000, lastUsedAt: now });
  const a = createAuth({ store: h.store, canRevoke: canRevokeOf(h.store), config: cfg(), secrets: secrets(), fetch: h.gh.fetch, clock: h.clock, log: quietLog() });
  assert.deepEqual([...h.keys.keys()].sort(), ['key-new', 'key-old', 'key-other'], 'no key is dropped at load');
  assert.deepEqual(a.agentKeysInfo({ id: '1001' }), [
    { kid: kidOf('key-new'), name: 'Claude Code', createdAt: now - 1000, lastUsedAt: now },
    { kid: kidOf('key-old'), name: null, createdAt: now - 5000, lastUsedAt: now },
  ], 'newest first');
  assert.deepEqual(a.agentKeysInfo({ id: '3003' }), []);
  const begin = a.beginLogin();
  h.gh.challenge = new URL(begin.location).searchParams.get('code_challenge');
  await a.completeLogin({ code: 'good-code', state: begin.state, expected: begin });
  const mine = [...h.sessions.entries()].filter(([, s]) => s.userId === '1001');
  assert.equal(mine.length, 10, 'the 11th session pushed the oldest loaded one out');
  assert.equal(h.sessions.has('old-session-0'), false);
  assert.equal(h.sessions.has('old-session-9'), true);
});

test('createApp gives GitHub its own fetch when one is given, else the shared one', T, async (t) => {
  const gh = fakeGithub();
  const dir = mkTmp('auth-gh-');
  t.after(() => rmTmp(dir));
  let n = 0;
  const mk = (extra) => {
    const store = createStore({ file: path.join(dir, `rooms-${n++}.json`), log: quietLog() });
    store.load();
    const app = createApp({ config: cfg(), secrets: secrets(), log: quietLog(), store, proxy: fakeProxy(), clock: { sleep: async () => {} }, ...extra });
    t.after(() => app.close());
    return app;
  };
  const complete = async (app) => { const b = app.auth.beginLogin(); gh.challenge = new URL(b.location).searchParams.get('code_challenge'); return app.auth.completeLogin({ code: 'good-code', state: b.state, expected: b }); };
  const boom = async () => { throw new Error('the proxy fetch must not reach GitHub'); };
  assert.ok((await complete(mk({ fetch: boom, githubFetch: gh.fetch }))).token, 'githubFetch wins');
  assert.ok((await complete(mk({ fetch: gh.fetch }))).token, 'fetch is the fallback');
});

test('the housekeeping sweep runs each part on its own: one that throws is logged and does not stop createApp', T, async (t) => {
  const dir = mkTmp('auth-sweepfail-');
  t.after(() => rmTmp(dir));
  const { out, log } = capture();
  const store = createStore({ file: path.join(dir, 'rooms.json'), log });
  store.load();
  // Nothing reads the session map when auth is built; the sweep's read of it throws.
  const map = store.collection('session').map;
  let reads = 0;
  map[Symbol.iterator] = function () { reads++; throw new Error('sweep boom SECRETTEXT'); };
  const app = createApp({ config: cfg(), secrets: secrets(), log, store, proxy: fakeProxy(), clock: { sleep: async () => {} } });
  t.after(() => { delete map[Symbol.iterator]; app.close(); });
  const logged = out.join('');
  assert.match(logged, /event="app\.sweep_failed" errorClass="Error"/);
  assert.ok(!logged.includes('SECRETTEXT'));
});

test('every refusal of the sign-in guards carries a machine code, and every 401 says one sentence', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const origin = await h.post('/api/rooms', { origin: 'https://evil.test', cookie: s.cookie, body: roomBody });
  assert.deepEqual([origin.status, origin.json.code], [403, 'origin']);
  const type = await h.post('/api/rooms', { type: 'text/plain', cookie: s.cookie, body: roomBody });
  assert.deepEqual([type.status, type.json.code], [415, 'content_type']);
  for (const p of ['/api/rooms', '/api/me/agent-key', '/api/me/agent-key/revoke']) {
    const r = await h.post(p, { body: roomBody });
    assert.deepEqual([r.status, r.json], [401, { error: 'Sign in to open a live room.', code: 'signin_required' }], p);
  }
});

test('the saving-unavailable error comes from one factory in lib/errors.js', () => {
  const { savingUnavailable } = require('../lib/errors');
  const e = savingUnavailable();
  assert.deepEqual([e.code, e.message, e.apiCode], [503, 'Saving is unavailable right now. Try again in a minute.', 'saving_unavailable']);
  for (const file of ['rooms.js', 'http-auth.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');
    assert.ok(!src.includes('Saving is unavailable'), file + ' spells the sentence itself');
    assert.ok(src.includes('savingUnavailable'), file + ' does not use the factory');
  }
});

// ---------- pass-2 fixes ----------
test('a repeated revoke or logout is not "done" while the store is failing, and is once it has recovered (an unknown token forces no write)', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const { kid } = (await h.post('/api/me/agent-key', { cookie: s.cookie })).json;
  h.store.failing = true;
  h.store.persistCalls.length = 0;
  for (let i = 0; i < 3; i++) {
    assert.equal((await revokeKid(h, s, kid)).status, 503, 'revoke ' + i);
  }
  for (let i = 0; i < 3; i++) {
    const out = await h.post('/auth/logout', { cookie: s.cookie });
    assert.equal(out.status, 503, 'logout ' + i);
  }
  h.store.failing = false;
  assert.equal((await revokeKid(h, s, kid)).status, 401, 'the session is gone: nothing to authenticate with');
  // With a session of their own the same user sees 204 once the store is healthy.
  const s2 = await signIn(h);
  assert.equal((await revokeKid(h, s2, kid)).status, 204);
  assert.equal((await h.post('/auth/logout', { cookie: s2.cookie })).status, 204);
  assert.equal((await h.post('/auth/logout', { cookie: s2.cookie })).status, 204, 'a logout with no session left is fine on a healthy store');
});

test('a repeated revoke or logout: nothing owed costs no I/O and answers whether the store can take revocations; an unconfirmed one waits for its write again', T, async (t) => {
  let ok = true;
  const h = mkAuth(t, { persist: async () => ok });
  const user = h.auth.userForSession((await login(h)).token);
  const spy = { settle: 0 };
  const realSettle = h.store.settle;
  h.store.settle = () => { spy.settle++; return realSettle(); };
  h.store.persistCalls.length = 0;
  // Nothing to remove: no persist, no settle.
  const NOKID = '0123456789ab';
  assert.equal(await h.auth.revokeAgentKey(user, NOKID), true);
  for (const nothing of ['no-such-token', undefined, '', 'x'.repeat(300), 7]) assert.equal(await h.auth.logout(nothing), true, String(nothing));
  assert.deepEqual(h.store.persistCalls, []);
  assert.equal(spy.settle, 0);
  h.store.failing = true;
  assert.equal(await h.auth.revokeAgentKey(user, NOKID), false, 'a failing store takes no revocation');
  assert.equal(await h.auth.logout('no-such-token'), false);
  assert.deepEqual(h.store.persistCalls, []);
  h.store.failing = false;
  // A real logout whose write does not land: a repeat waits for that write again, until it lands.
  const { token } = await login(h);
  ok = false;
  assert.equal(await h.auth.logout(token), false);
  h.store.persistCalls.length = 0;
  assert.equal(await h.auth.logout(token), false, 'still owed');
  assert.deepEqual(h.store.persistCalls, [['session', sha256(token)]], 'and asked again, for that id only');
  ok = true;
  assert.equal(await h.auth.logout(token), true, 'saved now');
  h.store.persistCalls.length = 0;
  assert.equal(await h.auth.logout(token), true);
  assert.deepEqual(h.store.persistCalls, [], 'and no longer owed: no I/O');
  // The same for a key.
  const { kid } = await h.auth.mintAgentKey(user, '');
  ok = false;
  assert.equal(await h.auth.revokeAgentKey(user, kid), false);
  h.store.persistCalls.length = 0;
  assert.equal(await h.auth.revokeAgentKey(user, kid), false, 'still owed');
  assert.equal(h.store.persistCalls.length, 1);
  assert.equal(await h.auth.revokeAgentKey(user, NOKID), true, 'a kid that names nothing owed costs no I/O');
  assert.equal(h.store.persistCalls.length, 1);
  ok = true;
  assert.equal(await h.auth.revokeAgentKey(user, kid), true);
  h.store.persistCalls.length = 0;
  assert.equal(await h.auth.revokeAgentKey(user, kid), true);
  assert.deepEqual(h.store.persistCalls, []);
  assert.equal(spy.settle, 0, 'none of it settled the store');
});

test('an owed revocation of one user does not leak into another: a revoke by someone else costs no I/O', T, async (t) => {
  let ok = true;
  const h = mkAuth(t, { persist: async () => ok });
  const a = h.auth.userForSession((await login(h)).token);
  h.gh.id = 2002; h.gh.login = 'other';
  const b = h.auth.userForSession((await login(h)).token);
  const { kid } = await h.auth.mintAgentKey(a, '');
  ok = false;
  await h.auth.revokeAgentKey(a, kid); // owed
  h.store.persistCalls.length = 0;
  ok = true;
  assert.equal(await h.auth.revokeAgentKey(b, kid), true);
  assert.deepEqual(h.store.persistCalls, [], 'b owes nothing: not even for the kid a owes');
  assert.equal(await h.auth.revokeAgentKey(a, kid), true);
  assert.equal(h.store.persistCalls.length, 1, 'a settles what a owed');
});

test('the sweep forgets what the store has since made durable, so a later repeat costs no I/O', T, async (t) => {
  let ok = false;
  const h = mkAuth(t, { persist: async () => ok });
  const { token } = await login(h);
  await h.auth.logout(token); // owed
  ok = true;
  h.auth.sweep();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // let the settle the sweep started finish
  h.store.persistCalls.length = 0;
  assert.equal(await h.auth.logout(token), true);
  assert.deepEqual(h.store.persistCalls, [], 'forgotten');
});

test('K1: 50 logouts with random cookies while rooms are dirty cause no store write at all', T, async (t) => {
  // A store whose timer never fires, so any write there is one the code asked for.
  const dir = mkTmp('auth-k1-');
  t.after(() => rmTmp(dir));
  const file = path.join(dir, 'rooms.json');
  const store = createStore({ file, log: quietLog(), clock: { setTimeout: () => ({}), clearTimeout() {} } });
  store.load();
  const wrapped = wrapStore(store);
  let settles = 0;
  const realSettle = wrapped.settle;
  wrapped.settle = () => { settles++; return realSettle(); };
  const app = createApp({ config: cfg(), secrets: secrets(), log: quietLog(), store: wrapped, proxy: fakeProxy(), clock: { sleep: async () => {} } });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => { if (app.server.closeAllConnections) app.server.closeAllConnections(); app.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (let i = 0; i < 5; i++) app.domain.createDemoRoom(); // dirty rooms: a pass of the write cycle would write them
  assert.equal(fs.existsSync(file), false, 'nothing has been written yet');
  for (let i = 0; i < 50; i++) {
    const cookie = `${SESSION}=${crypto.randomBytes(32).toString('base64url')}`;
    const r = await request(base, 'POST', '/auth/logout', { headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': '2', cookie }, body: '{}' });
    assert.equal(r.status, 204);
  }
  assert.equal(fs.existsSync(file), false, 'no logout caused a write of the dirty rooms');
  assert.deepEqual(wrapped.persistCalls, []);
  assert.equal(settles, 0);
  assert.equal(store.flush(), true);
  assert.equal(fs.existsSync(file), true, 'a pass does write them (so the check above could have failed)');
});

test('the callback limiter is called with the client address once the state matched: a bare callback is no attempt, and a missing address is not a free pass', T, async (t) => {
  const h = mkAuth(t);
  for (let i = 0; i < 40; i++) await failure(h.auth.completeLogin({ code: 'x', state: 'nope', expected: null, ip: '203.0.113.9' }));
  for (let i = 0; i < 40; i++) await failure(h.auth.completeLogin({ code: 'x', state: 'nope', expected: { state: 'other', verifier: 'v' }, ip: '203.0.113.9' }));
  assert.ok((await login(h, undefined, '203.0.113.9')).token, 'none of that counted');
  // Real attempts count, per address; a missing address shares one key.
  const attempt = (ip) => { const b = h.auth.beginLogin(); return failure(h.auth.completeLogin({ code: 'wrong', state: b.state, expected: b, ip })); };
  for (let i = 0; i < 19; i++) assert.equal((await attempt('203.0.113.9')).code, 'AUTH_EXCHANGE');
  assert.equal((await attempt('203.0.113.9')).code, 'AUTH_RATE');
  assert.equal((await attempt('203.0.113.10')).code, 'AUTH_EXCHANGE', 'another address');
  for (let i = 0; i < 20; i++) await attempt(undefined);
  assert.equal((await attempt(undefined)).code, 'AUTH_RATE');
  assert.equal(h.out.join('').split('\n').filter((l) => l.includes('code="AUTH_RATE"')).length, 2, 'one line per bucket, from checkRate alone');
});

test('sweep and agentKeysInfo drop an agent key that has been idle for 90 days', T, async (t) => {
  const h = mkAuth(t);
  const user = h.auth.userForSession((await login(h)).token);
  const made = await h.auth.mintAgentKey(user, '');
  assert.deepEqual(h.auth.agentKeysInfo(user), [{ kid: made.kid, name: null, createdAt: h.clock.t, lastUsedAt: null }]);
  h.clock.t += 90 * DAY - 1;
  assert.equal(h.auth.agentKeysInfo(user).length, 1);
  h.auth.sweep();
  assert.equal(h.keys.size, 1, 'not yet');
  h.clock.t += 1;
  assert.deepEqual(h.auth.agentKeysInfo(user), [], 'an idle key is not listed');
  assert.equal(h.keys.size, 1, 'agentKeysInfo only reports');
  h.auth.sweep();
  assert.equal(h.keys.size, 0, 'sweep deletes it');
  // and the next one is minted as normal
  assert.ok(await h.auth.mintAgentKey(h.auth.userForSession((await login(h)).token), ''));
});

test('the callback limit is per client address (the trusted forwarded one), and replays of a spent state count as attempts', T, async (t) => {
  const h = await boot(t);
  const from = (ip) => ({ 'x-forwarded-for': ip });
  for (let i = 0; i < 20; i++) await signIn(h, { code: 'bad', headers: from('203.0.113.1') });
  assert.equal((await signIn(h, { headers: from('203.0.113.1') })).session, null, 'the 21st from one address');
  assert.ok((await signIn(h, { headers: from('203.0.113.2') })).session, 'another address is not affected');
  // A state that has been used, replayed: refused as a state, and counted.
  const h2 = mkAuth(t);
  const b = h2.auth.beginLogin();
  const args = { code: 'wrong', state: b.state, expected: b, ip: '198.51.100.5' };
  await failure(h2.auth.completeLogin(args));
  for (let i = 0; i < 25; i++) assert.ok(['AUTH_STATE', 'AUTH_RATE'].includes((await failure(h2.auth.completeLogin(args))).code));
  const fresh = h2.auth.beginLogin();
  assert.equal((await failure(h2.auth.completeLogin({ code: 'good-code', state: fresh.state, expected: fresh, ip: '198.51.100.5' }))).code, 'AUTH_RATE', 'the replays used the allowance up');
});

// ---------- restarts: the accounts survive a restart on either store, and the indexes are rebuilt ----------
// These tests get a database of their own (created once for this file): the Postgres store takes an advisory lock per database and
// test/store-pg.test.js drops its table, and node --test runs the two files at the same time.
const authDb = PG_URL ? scratchDatabase('behalf_auth_test') : null;
if (authDb) { before(() => authDb.create()); after(() => authDb.drop()); }

// Each backend: open() loads a store over the same data every time.
const BACKENDS = [
  {
    name: 'file store',
    make: async (t) => {
      const dir = mkTmp('auth-restart-');
      const opened = [];
      t.after(async () => { for (const s of opened) await s.close().catch(() => {}); rmTmp(dir); });
      return { open: async () => { const s = createStore({ file: path.join(dir, 'rooms.json'), log: quietLog() }); s.load(); opened.push(s); return s; } };
    },
  },
  {
    name: 'Postgres store',
    skip: !PG_URL,
    make: async (t) => {
      const { createPgStore } = require('../lib/store-pg');
      await authDb.reset(); // an empty table for this test
      const opened = [];
      t.after(async () => { for (const s of opened) await s.close().catch(() => {}); });
      return { open: async () => { const s = createPgStore({ url: authDb.url, log: quietLog(), debounceMs: 25 }); await s.load(); opened.push(s); return s; } };
    },
  },
];

for (const b of BACKENDS) {
  test(`restart on the ${b.name}: sessions, users and agent keys survive, the indexes are rebuilt, a block added in between applies, and revocations stay revoked`, { ...T, skip: b.skip }, async (t) => {
    const be = await b.make(t);
    const gh = fakeGithub();
    const clock = mkClock();
    const mk = (store, extra = {}) => createAuth({ store, canRevoke: canRevokeOf(store), config: cfg(extra), secrets: secrets(), fetch: gh.fetch, clock, log: quietLog() });
    const signIn1 = async (auth, id, login) => {
      gh.id = id; gh.login = login;
      const begin = auth.beginLogin();
      gh.challenge = new URL(begin.location).searchParams.get('code_challenge');
      return (await auth.completeLogin({ code: gh.code, state: begin.state, expected: begin })).token;
    };
    const restart = async (store) => { assert.equal(await store.settle(), true); await store.close(); return be.open(); };

    // Life one: two users sign in, each mints a key; the first signs in twice.
    let store = await be.open();
    let auth = mk(store);
    const a1 = await signIn1(auth, 1001, 'octocat');
    const a2 = await signIn1(auth, 1001, 'octocat');
    const bTok = await signIn1(auth, 1002, 'other');
    const aMade = await auth.mintAgentKey({ id: '1001' }, 'Claude Desktop');
    const aKey = aMade.key;
    const bMade = await auth.mintAgentKey({ id: '1002' }, '');
    const bKey = bMade.key;

    // Life two: everything is still there, and the indexes work (several keys per user, the 10-session cap).
    store = await restart(store);
    auth = mk(store);
    assert.deepEqual(auth.userForSession(a1), { id: '1001', login: 'octocat' });
    assert.deepEqual(auth.userForSession(a2), { id: '1001', login: 'octocat' });
    assert.deepEqual(auth.userForAgentKey(aKey), { id: '1001', login: 'octocat' });
    assert.deepEqual(auth.userForAgentKey(bKey), { id: '1002', login: 'other' });
    assert.deepEqual(auth.agentKeysInfo({ id: '1001' }).map((k) => [k.kid, k.name]), [[aMade.kid, 'Claude Desktop']], 'the kid is the same after a restart: it is derived, not stored');
    const aMade2 = await auth.mintAgentKey({ id: '1001' }, 'Claude Code');
    const aKey2 = aMade2.key;
    assert.ok(auth.userForAgentKey(aKey), 'a new key replaces nothing');
    assert.ok(auth.userForAgentKey(aKey2));
    assert.deepEqual(auth.agentKeysInfo({ id: '1001' }).map((k) => k.kid).sort(), [aMade2.kid, aMade.kid].sort());
    assert.ok(auth.userForAgentKey(bKey), 'the other user keeps theirs');
    for (let i = 0; i < 9; i++) await signIn1(auth, 1001, 'octocat');
    assert.equal(auth.userForSession(a1), null, 'the loaded sessions were counted: the oldest went at the 11th');
    assert.ok(auth.userForSession(a2));
    assert.ok(auth.userForSession(bTok));
    // A logout and a revoke are confirmed before they answer.
    assert.equal(await auth.logout(a2), true);
    assert.equal(await auth.revokeAgentKey({ id: '1002' }, bMade.kid), true);
    assert.equal(await auth.revokeAgentKey({ id: '1001' }, aMade.kid), true);

    // Life three: the revocations are durable, the other key is the one stored, and id 1001 is now blocked.
    store = await restart(store);
    auth = mk(store);
    assert.equal(auth.userForSession(a2), null, 'a logout survives a restart');
    assert.equal(auth.userForAgentKey(bKey), null, 'a revoke survives a restart');
    assert.deepEqual(auth.agentKeysInfo({ id: '1002' }), []);
    assert.equal(auth.userForAgentKey(aKey), null, 'a deleted key stays deleted');
    assert.ok(auth.userForAgentKey(aKey2));
    assert.deepEqual(auth.agentKeysInfo({ id: '1001' }).map((k) => [k.kid, k.name]), [[aMade2.kid, 'Claude Code']]);
    assert.ok(auth.userForSession(bTok));
    const blocked = mk(store, { GITHUB_BLOCKED_IDS: '1001' });
    assert.equal(blocked.userForAgentKey(aKey2), null, 'a block added between restarts applies to the stored key');
    assert.equal(blocked.agentKeysInfo({ id: '1001' }).length, 1, 'the record is still there until the sweep');
    blocked.sweep();
    assert.deepEqual(blocked.agentKeysInfo({ id: '1001' }), []);
    assert.ok(blocked.userForSession(bTok), 'another user is untouched');
    assert.equal(await store.settle(), true);

    // Life four: the sweep's deletions were saved too.
    store = await restart(store);
    const last = mk(store);
    assert.equal(last.userForAgentKey(aKey2), null);
    assert.equal(store.collection('session').map.size, 1, 'only the other user has a session left');
    assert.ok(last.userForSession(bTok));
  });
}

for (const b of BACKENDS) {
  test(`restart on the ${b.name}: a session or agent key that slid its idle timeout before the restart is still alive after it`, { ...T, skip: b.skip }, async (t) => {
    const be = await b.make(t);
    const gh = fakeGithub();
    const clock = mkClock();
    const mk = (store) => createAuth({ store, canRevoke: canRevokeOf(store), config: cfg(), secrets: secrets(), fetch: gh.fetch, clock, log: quietLog() });
    let store = await be.open();
    let auth = mk(store);
    const begin = auth.beginLogin();
    gh.challenge = new URL(begin.location).searchParams.get('code_challenge');
    const { token } = await auth.completeLogin({ code: gh.code, state: begin.state, expected: begin });
    assert.equal(await store.settle(), true); // the login is written, so only what changes after this is a mark to look for
    clock.t += 6 * DAY; // inside the 7-day idle timeout: used, so lastSeenAt moves to day 6
    assert.ok(auth.userForSession(token));
    assert.equal(await store.settle(), true); // what save() marked is written, with no persist() of this record to do it
    await store.close();
    store = await be.open();
    auth = mk(store);
    clock.t += 6 * DAY; // day 12: 12 days since login, 6 since the last use
    assert.ok(auth.userForSession(token), 'the slid lastSeenAt was saved');
    clock.t += 19 * DAY; // day 31: past the 30-day hard cap
    assert.equal(auth.userForSession(token), null);
    // The same for an agent key: used on day 80 (nine days short of the 90-day idle limit), it must still work on day 160.
    const minted = await auth.mintAgentKey({ id: '1001' }, '');
    assert.equal(await store.settle(), true);
    clock.t += 80 * DAY; // day 111, 80 days after the mint
    assert.ok(auth.userForAgentKey(minted.key));
    assert.equal(await store.settle(), true);
    await store.close();
    store = await be.open();
    auth = mk(store);
    clock.t += 80 * DAY;
    assert.ok(auth.userForAgentKey(minted.key), 'the slid lastUsedAt was saved');
    clock.t += 91 * DAY;
    assert.equal(auth.userForAgentKey(minted.key), null, 'and 91 idle days still end it');
  });
}

test('over HTTP, a restart on the same data keeps the session cookie working, and a logout stays done', T, async (t) => {
  const dir = mkTmp('auth-http-restart-');
  t.after(() => rmTmp(dir));
  const gh = fakeGithub();
  const clock = mkClock(Date.now());
  const run = async (fn) => {
    const { log } = capture();
    const config = loadConfig({ SIGNIN: 'github', DROP_DATA_DIR: path.join(dir, 'data'), PUBLIC_URL: PUBLIC });
    const store = createStore({ file: path.join(dir, 'data', 'rooms.json'), log });
    store.load();
    const app = createApp({ config, secrets: secrets(), log, store, proxy: fakeProxy(), clock: { sleep: async () => {}, now: clock.now }, fetch: gh.fetch });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${app.server.address().port}`;
    try { return await fn((m, p, o) => request(root, m, p, o)); } finally { await app.drain().catch(() => {}); if (app.server.closeAllConnections) app.server.closeAllConnections(); app.close(); }
  };
  const post = (req, p, cookie) => req('POST', p, { headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': '11', cookie }, body: '{"name":""}' });
  const cookie = await run(async (req) => {
    const begin = await req('GET', '/auth/github');
    const loc = new URL(begin.headers.location);
    gh.challenge = loc.searchParams.get('code_challenge');
    const cb = await req('GET', `/auth/github/callback?code=${gh.code}&state=${encodeURIComponent(loc.searchParams.get('state'))}`, { headers: { cookie: `${OAUTH}=${cookieValue(begin, OAUTH)}` } });
    const c = `${SESSION}=${cookieValue(cb, SESSION)}`;
    const minted = await post(req, '/api/me/agent-key', c);
    assert.equal(minted.status, 201, minted.text);
    return c;
  });
  await run(async (req) => {
    const me = await req('GET', '/api/me', { headers: { cookie } });
    assert.equal(me.json.user.login, 'octocat');
    assert.ok(me.json.agentKeys[0].createdAt, 'the agent key survived too');
    assert.equal((await post(req, '/auth/logout', cookie)).status, 204);
  });
  await run(async (req) => {
    assert.equal((await req('GET', '/api/me', { headers: { cookie } })).json.user, null, 'the logout survived a restart');
  });
});

// ---------- live rooms with sign-in: the owner, the per-user quota, MCP create_room and the agent key ----------
const KEY_MISSING = `create_room needs an agent key: your principal signs in at ${PUBLIC}/key, creates one, and adds it to your MCP client as an Authorization header.`;
const KEY_REJECTED = `That agent key no longer works: your principal signs in at ${PUBLIC}/key and creates a new one, then updates the Authorization header in your MCP client.`;
const mcpCall = (h, name, args, headers = {}) => h.req('POST', '/mcp', {
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
});
const toolText = (r) => r.json.result.content[0].text;
const toolOut = (r) => r.json.result.structuredContent;
const mintMade = async (h, s, body) => (await h.post('/api/me/agent-key', { cookie: s.cookie, body })).json;
const mintKey = async (h, s) => (await mintMade(h, s)).key;
const bearer = (key) => ({ authorization: `Bearer ${key}` });
const mcpRoom = { topic: 'Over MCP', your_principal: 'Ann', counterpart: 'Ben' };

test('sign-in on: the domain refuses a live room with no user, with the same sentence and code as the web guard', T, async (t) => {
  const h = await boot(t);
  assert.throws(() => h.app.domain.createLiveRoom('203.0.113.1', roomBody), (e) => e.code === 401 && e.apiCode === 'signin_required' && e.message === 'Sign in to open a live room.');
  assert.throws(() => h.app.ops.createLiveRoom('203.0.113.1', { ...roomBody, user: { id: '1001' }, ownerId: '1001' }), (e) => e.code === 401, 'a user in the body is not a user');
  assert.equal(h.app.domain.rooms.size, 0);
  assert.equal(Object.keys(h.app.store.state.usage.byUser).length, 0, 'nothing was counted');
  const web = await h.post('/api/rooms', { body: roomBody });
  assert.deepEqual([web.status, web.json], [401, { error: 'Sign in to open a live room.', code: 'signin_required' }]);
});

test('sign-in on: a web room is owned by the signed-in user, a user in the body changes nothing, and the quota counts that user', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const r = await h.post('/api/rooms', { cookie: s.cookie, body: { ...roomBody, user: { id: '42' }, ownerId: '42' } });
  assert.equal(r.status, 201, r.text);
  const room = h.app.domain.rooms.get(r.json.id);
  assert.equal(room.ownerId, '1001');
  assert.deepEqual(Object.assign({}, h.app.store.state.usage.byUser), { 1001: 1 });
  assert.equal(h.app.store.state.usage.total, 1);
  const demo = await h.post('/api/demo', {});
  assert.equal(demo.status, 201);
  assert.ok(!('ownerId' in h.app.domain.rooms.get(demo.json.id)), 'a demo room has no owner');
});

test('sign-in on: the quota is the account\'s: a third room is 429, another user is fine, and the same user from another address is still capped', T, async (t) => {
  const h = await boot(t, { extra: { PER_USER_DAILY: '2' } });
  const sentence = 'You have opened the maximum live rooms for today. The demo is unlimited.';
  const { domain } = h.app;
  const ann = { id: '1001', login: 'octocat' };
  const bob = { id: '1002', login: 'hubot' };
  domain.createLiveRoom('203.0.113.1', roomBody, ann);
  domain.createLiveRoom('203.0.113.2', roomBody, ann);
  const usage = h.app.store.state.usage;
  assert.throws(() => domain.createLiveRoom('203.0.113.3', roomBody, ann), (e) => e.code === 429 && e.message === sentence && e.apiCode === 'user_limit', 'the same user from a third address');
  assert.throws(() => domain.createLiveRoom('203.0.113.1', roomBody, ann), (e) => e.code === 429 && e.apiCode === 'user_limit', 'and from an address it used');
  assert.equal(usage.total, 2, 'a refusal counts nothing');
  domain.createLiveRoom('203.0.113.1', roomBody, bob);
  assert.deepEqual(Object.assign({}, usage.byUser), { 1001: 2, 1002: 1 });
  assert.deepEqual(Object.assign({}, usage.byIp), {}, 'a signed-in user is not counted by address');
  assert.equal(domain.rooms.size, 3);
  // Over the web too: the same sentence, now with its own code.
  const s = await signIn(h);
  const web = await h.post('/api/rooms', { cookie: s.cookie, body: roomBody });
  assert.deepEqual([web.status, web.json], [429, { error: sentence, code: 'user_limit' }]);
});

test('sign-in on: the address does not limit signed-in users: two users behind one address each reach their own limit; the global limit still applies', T, async (t) => {
  const h = await boot(t, { extra: { PER_USER_DAILY: '2', PER_IP_DAILY: '1', DAILY_ROOM_LIMIT: '5' } });
  const { domain } = h.app;
  const usage = h.app.store.state.usage;
  const [u1, u2, u3] = ['1', '2', '3'].map((id) => ({ id, login: 'u' + id }));
  for (const u of [u1, u1, u2, u2]) domain.createLiveRoom('203.0.113.1', roomBody, u); // PER_IP_DAILY is 1: it is not what stops them
  assert.throws(() => domain.createLiveRoom('203.0.113.1', roomBody, u1), (e) => e.apiCode === 'user_limit');
  assert.throws(() => domain.createLiveRoom('203.0.113.1', roomBody, u2), (e) => e.apiCode === 'user_limit');
  domain.createLiveRoom('203.0.113.1', roomBody, u3);
  assert.equal(usage.total, 5);
  assert.throws(() => domain.createLiveRoom('203.0.113.1', roomBody, u3), (e) => e.code === 429 && e.apiCode === 'daily_limit' && /Daily room limit/.test(e.message), 'the global limit');
  assert.equal(usage.byUser['3'], 1, 'a refusal counted nothing');
  assert.equal(Object.keys(usage.byIp).length, 0);
});

test('sign-in off: the per-address limit is exactly as before, with its own code, and the global one too', T, async (t) => {
  const h = await boot(t, { signin: 'off', extra: { PER_IP_DAILY: '1', DAILY_ROOM_LIMIT: '2' } });
  const { domain } = h.app;
  domain.createLiveRoom('203.0.113.1', roomBody);
  assert.throws(() => domain.createLiveRoom('203.0.113.1', roomBody), (e) => e.code === 429 && e.apiCode === 'ip_limit' && e.message === 'You have opened the maximum live rooms for today. The demo is unlimited.');
  domain.createLiveRoom('203.0.113.2', roomBody);
  assert.throws(() => domain.createLiveRoom('203.0.113.3', roomBody), (e) => e.code === 429 && e.apiCode === 'daily_limit');
  assert.deepEqual(Object.assign({}, h.app.store.state.usage.byIp), { '203.0.113.1': 1, '203.0.113.2': 1 });
});

test('sign-in on: the per-user count resets at the day rollover', T, async (t) => {
  const h = await boot(t, { extra: { PER_USER_DAILY: '1' } });
  const { domain } = h.app;
  const ann = { id: '1001', login: 'octocat' };
  domain.createLiveRoom('203.0.113.1', roomBody, ann);
  assert.throws(() => domain.createLiveRoom('203.0.113.1', roomBody, ann), (e) => e.code === 429);
  h.clock.t += 2 * DAY;
  domain.createLiveRoom('203.0.113.1', roomBody, ann);
  assert.deepEqual(Object.assign({}, h.app.store.state.usage.byUser), { 1001: 1 });
});

for (const b of BACKENDS) {
  test(`sign-in on, ${b.name}: the owner and the per-user count survive a restart, and a restart does not give the day back`, { ...T, skip: b.skip }, async (t) => {
    const be = await b.make(t);
    const clock = mkClock(Date.now());
    const config = cfg({ PER_USER_DAILY: '2', PER_IP_DAILY: '100', DAILY_ROOM_LIMIT: '100' });
    const open = async () => {
      const store = await be.open();
      const app = createApp({ config, secrets: secrets(), log: quietLog(), store, proxy: fakeProxy(), clock: { sleep: async () => {}, now: clock.now } });
      return { store, app };
    };
    const close = async ({ store, app }) => { app.domain.stop(); assert.equal(await store.settle(), true); await store.close(); };
    const ann = { id: '1001', login: 'octocat' };
    const first = await open();
    const room = first.app.domain.createLiveRoom('203.0.113.1', roomBody, ann);
    first.app.domain.createLiveRoom('203.0.113.1', roomBody, ann);
    await close(first);
    const second = await open();
    assert.equal(second.app.domain.rooms.get(room.id).ownerId, '1001');
    assert.deepEqual(Object.assign({}, second.store.state.usage.byUser), { 1001: 2 });
    assert.throws(() => second.app.domain.createLiveRoom('203.0.113.9', roomBody, ann), (e) => e.code === 429);
    clock.t += 2 * DAY;
    second.app.domain.createLiveRoom('203.0.113.1', roomBody, ann);
    await close(second);
    const third = await open();
    assert.deepEqual(Object.assign({}, third.store.state.usage.byUser), { 1001: 1 }, 'the reset was saved');
    await close(third);
  });
}

test('MCP create_room with sign-in on: no key, a wrong key and a malformed header get one of two fixed sentences: none says missing, any header says rejected, and echo nothing', T, async (t) => {
  const h = await boot(t);
  const wrong = 'bh_not-a-real-key-1234567890';
  for (const headers of [{}, bearer(wrong), { authorization: wrong }, { authorization: 'Bearer' }, { authorization: 'Basic abc' }, { authorization: 'Bearer a b' }]) {
    const r = await mcpCall(h, 'create_room', mcpRoom, headers);
    assert.equal(r.status, 200);
    assert.equal(r.json.result.isError, true, JSON.stringify(headers));
    assert.equal(toolText(r), headers.authorization === undefined ? KEY_MISSING : KEY_REJECTED, JSON.stringify(headers));
    assert.ok(!r.text.includes(wrong));
  }
  assert.equal(h.app.domain.rooms.size, 0);
  assert.equal(h.app.store.state.usage.total, 0);
  assert.ok(!h.out.join('').includes(wrong), 'never logged');
});

test('MCP create_room with a valid agent key: the room is owned by the key\'s user and counted on that user, and the seat link is all the other tools need', T, async (t) => {
  const h = await boot(t, { extra: { PER_USER_DAILY: '2' } });
  const s = await signIn(h);
  const key = await mintKey(h, s);
  const r = await mcpCall(h, 'create_room', mcpRoom, bearer(key));
  assert.notEqual(r.json.result.isError, true, toolText(r));
  const out = toolOut(r);
  const room = h.app.domain.rooms.get(out.room_id);
  assert.equal(room.ownerId, '1001');
  assert.equal(room.seats.A.mode, 'external');
  assert.deepEqual(Object.assign({}, h.app.store.state.usage.byUser), { 1001: 1 });
  assert.equal(Object.keys(h.app.store.state.usage.byIp).length, 0, 'counted on the user, not the address');
  // The same user over the web shares the allowance.
  assert.equal((await h.post('/api/rooms', { cookie: s.cookie, body: roomBody })).status, 201);
  const third = await mcpCall(h, 'create_room', mcpRoom, bearer(key));
  assert.equal(third.json.result.isError, true);
  assert.equal(toolText(third), 'You have opened the maximum live rooms for today. The demo is unlimited.');
  // No key header for the rest: the seat link is the credential.
  const link = out.your_link;
  const joined = await mcpCall(h, 'join_room', { link, agent_name: 'Agent A' });
  assert.notEqual(joined.json.result.isError, true, toolText(joined));
  const card = { principal: { name: 'Ann' }, goal: 'g', must_haves: ['m'] };
  const sealed = await mcpCall(h, 'seal_intent_card', { link, card });
  assert.notEqual(sealed.json.result.isError, true, toolText(sealed));
  assert.notEqual((await mcpCall(h, 'get_room', { link })).json.result.isError, true);
  assert.notEqual((await mcpCall(h, 'wait_for_turn', { link, timeout_seconds: 1 })).json.result.isError, true);
  // And the invite link for seat B works the same way, from a client that holds no key.
  assert.notEqual((await mcpCall(h, 'join_room', { link: out.invite_link_for_counterpart, agent_name: 'Agent B' })).json.result.isError, true);
  assert.ok(!h.out.join('').includes(key), 'the key was never logged');
});

test('MCP create_room: a revoked key, a key whose user is gone and an idle key are refused, and a refusal counts nothing', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  // Revoked.
  const m1 = await mintMade(h, s);
  const k1 = m1.key;
  assert.notEqual((await mcpCall(h, 'create_room', mcpRoom, bearer(k1))).json.result.isError, true, 'it works first (so the refusal is the revocation)');
  assert.equal((await revokeKid(h, s, m1.kid)).status, 204);
  assert.equal(toolText(await mcpCall(h, 'create_room', mcpRoom, bearer(k1))), KEY_REJECTED);
  // Several keys work side by side; deleting one ends only that one.
  const m2 = await mintMade(h, s);
  const k2 = m2.key;
  const k3 = await mintKey(h, s);
  assert.notEqual((await mcpCall(h, 'create_room', mcpRoom, bearer(k2))).json.result.isError, true, 'a new key replaces nothing');
  assert.equal((await revokeKid(h, s, m2.kid)).status, 204);
  assert.equal(toolText(await mcpCall(h, 'create_room', mcpRoom, bearer(k2))), KEY_REJECTED);
  assert.notEqual((await mcpCall(h, 'create_room', mcpRoom, bearer(k3))).json.result.isError, true);
  // A user who is gone.
  const saved = h.users.get('1001');
  h.users.delete('1001');
  assert.equal(toolText(await mcpCall(h, 'create_room', mcpRoom, bearer(k3))), KEY_REJECTED);
  h.users.set('1001', saved);
  assert.notEqual((await mcpCall(h, 'create_room', mcpRoom, bearer(k3))).json.result.isError, true, 'and the same key works again with its user (so that was the cause)');
  const rooms = h.app.domain.rooms.size;
  // Idle for 90 days.
  h.clock.t += 91 * DAY;
  assert.equal(toolText(await mcpCall(h, 'create_room', mcpRoom, bearer(k3))), KEY_REJECTED);
  assert.equal(h.app.domain.rooms.size, rooms);
});

test('MCP create_room: a key of a blocked user is refused, through a second real app on the same store that blocks that id', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const key = await mintKey(h, s);
  assert.notEqual((await mcpCall(h, 'create_room', mcpRoom, bearer(key))).json.result.isError, true, 'unblocked, the key works');
  const config = loadConfig({ SIGNIN: 'github', PUBLIC_URL: PUBLIC, GITHUB_BLOCKED_IDS: '1001', PER_IP_DAILY: '100', PER_USER_DAILY: '100', DAILY_ROOM_LIMIT: '100' });
  const second = createApp({ config, secrets: secrets(), log: quietLog(), store: h.store, proxy: fakeProxy(), clock: { sleep: async () => {}, now: h.clock.now }, fetch: h.gh.fetch });
  await new Promise((resolve) => second.listen(0, '127.0.0.1', resolve));
  t.after(() => { second.domain.stop(); second.server.closeAllConnections(); second.server.close(); });
  const rooms = second.domain.rooms.size;
  const r = await mcpCall({ req: (m, p, o) => request(`http://127.0.0.1:${second.server.address().port}`, m, p, o) }, 'create_room', mcpRoom, bearer(key));
  assert.equal(toolText(r), KEY_REJECTED);
  assert.equal(second.domain.rooms.size, rooms, 'no room');
});

test('MCP create_room with the ops of a blocking auth: the wrapped lookup is refused (this proves only the MCP side of a null user)', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const key = await mintKey(h, s);
  const ops = { ...h.app.ops, userForAgentKey: () => null };
  const reqs = { method: 'POST', headers: { authorization: `Bearer ${key}` }, socket: { remoteAddress: '1.2.3.4' } };
  let body = '';
  const res = { writeHead() {}, end: (b) => { body = b || ''; } };
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_room', arguments: mcpRoom } };
  await require('../lib/mcp').handle(reqs, res, ops, { readBody: async () => rpc, clientIp: () => '1.2.3.4' });
  assert.equal(JSON.parse(body).result.content[0].text, KEY_REJECTED);
  assert.equal(h.app.domain.rooms.size, 0);
});

test('/mcp never reads a session cookie: a valid session does not authorize create_room, and a key does not need one', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const r = await mcpCall(h, 'create_room', mcpRoom, { cookie: s.cookie });
  assert.equal(toolText(r), KEY_MISSING);
  const bad = await mcpCall(h, 'create_room', mcpRoom, { cookie: s.cookie, ...bearer('bh_nope') });
  assert.equal(toolText(bad), KEY_REJECTED, 'a session next to a bad key is still a bad key');
  const key = await mintKey(h, s);
  assert.notEqual((await mcpCall(h, 'create_room', mcpRoom, bearer(key))).json.result.isError, true, 'the key alone is enough');
  assert.equal(h.app.domain.rooms.size, 1);
});

test('MCP: instructions and the create_room description are built per mode: on is off plus the agent-key clauses, and nothing else changes', () => {
  const mcp = require('../lib/mcp');
  const off = mcp.instructionsFor(false, PUBLIC);
  const on = mcp.instructionsFor(true, PUBLIC);
  assert.equal(off, mcp.INSTRUCTIONS);
  assert.deepEqual(mcp.toolsFor(false, PUBLIC), mcp.TOOLS);
  assert.notEqual(on, off);
  assert.match(on, /create_room also needs your principal's agent key, sent as an Authorization: Bearer header/);
  assert.ok(!/Authorization/.test(off), 'the off text says nothing of the key');
  // One inserted clause: cut it out and the two are the same.
  let i = 0;
  while (off[i] === on[i]) i++;
  const clause = on.slice(i, i + on.length - off.length);
  assert.equal(on.slice(0, i) + on.slice(i + clause.length), off, 'on adds one clause and removes nothing');
  assert.match(clause, /agent key/);
  const tools = mcp.toolsFor(true, PUBLIC);
  assert.deepEqual(tools.map((x) => x.name), mcp.TOOLS.map((x) => x.name));
  const changed = tools.filter((x, k) => JSON.stringify(x) !== JSON.stringify(mcp.TOOLS[k])).map((x) => x.name);
  assert.deepEqual(changed, ['create_room'], 'only the create_room description changes');
  assert.ok(tools[0].description.startsWith(mcp.TOOLS[0].description));
  assert.match(tools[0].description, /Authorization: Bearer header/);
  assert.deepEqual(tools[0].inputSchema, mcp.TOOLS[0].inputSchema);
  assert.ok('passcode' in tools[0].inputSchema.properties);
  assert.ok(!('agent_key' in tools[0].inputSchema.properties) && !('user' in tools[0].inputSchema.properties));
  // Exactly what the sign-in description adds: the off text, then the key clause, no passcode, and "Use our AI" for a builtin counterpart.
  const added = tools[0].description.slice(mcp.TOOLS[0].description.length);
  assert.match(added, /^ This server requires sign-in: your MCP client must send your principal's agent key as an Authorization: Bearer header \(not as an argument\)\./);
  assert.ok(added.includes(`Your principal gets a key at ${PUBLIC}/key. No passcode is needed.`), added);
  assert.ok(added.endsWith(`counterpart_proxy "builtin" also needs "Use our AI" access, which your principal asks for at ${PUBLIC}/start; without it, use "external".`), added);
  assert.ok(!/Use our AI|passcode/i.test(mcp.TOOLS[0].description), 'the off description says nothing of either');
  assert.equal(mcp.toolsFor(true, 'https://other.test')[0].description.includes(PUBLIC), false, 'the start URL is built per call too');
});

test('MCP over HTTP serves the instructions and the tool list of its mode', T, async (t) => {
  const mcp = require('../lib/mcp');
  const ask = (h, method, params) => h.req('POST', '/mcp', { headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const on = await boot(t);
  assert.equal((await ask(on, 'initialize', { protocolVersion: '2025-06-18' })).json.result.instructions, mcp.instructionsFor(true, PUBLIC));
  assert.deepEqual((await ask(on, 'tools/list')).json.result.tools, mcp.toolsFor(true, PUBLIC));
  const off = await boot(t, { signin: 'off' });
  assert.equal((await ask(off, 'initialize', { protocolVersion: '2025-06-18' })).json.result.instructions, mcp.INSTRUCTIONS);
  assert.deepEqual((await ask(off, 'tools/list')).json.result.tools, mcp.TOOLS);
});

test('MCP: the sign-in text and both refusals name the absolute key page, and the off-mode text is the constants themselves', T, async (t) => {
  const mcp = require('../lib/mcp');
  const { agentKeyRequired } = require('../lib/errors');
  assert.ok(mcp.instructionsFor(true, PUBLIC).includes(`${PUBLIC}/key`));
  assert.ok(mcp.toolsFor(true, PUBLIC).find((t) => t.name === 'create_room').description.includes(`${PUBLIC}/key`));
  assert.ok(mcp.instructionsFor(true, 'https://other.test').includes('https://other.test/key'), 'built per call, not cached');
  assert.ok(!mcp.instructionsFor(true, 'https://other.test').includes(PUBLIC), 'no stale URL from an earlier call');
  assert.equal(mcp.instructionsFor(false, PUBLIC), mcp.INSTRUCTIONS);
  assert.equal(mcp.toolsFor(false, PUBLIC), mcp.TOOLS);
  for (const rejected of [false, true]) {
    const e = agentKeyRequired(rejected, PUBLIC);
    assert.equal(e.code, 401);
    assert.ok(e.message.includes(`${PUBLIC}/key`), e.message);
    assert.ok(!/at \/connect/.test(e.message), 'no relative path');
  }
  const h = await boot(t);
  const r = await mcpCall(h, 'create_room', mcpRoom);
  assert.ok(toolText(r).includes(`${PUBLIC}/key`));
});

test('/key: GET and HEAD with sign-in on redirect to the key panel with a fixed target; sign-in off and other methods get the normal unknown-path 404', T, async (t) => {
  const on = await boot(t);
  for (const p of ['/key', '/key?next=//evil.test&x=1']) {
    for (const method of ['GET', 'HEAD']) {
      const r = await on.req(method, p);
      assert.equal(r.status, 302, method + ' ' + p);
      assert.equal(r.headers.location, '/connect#agent-keys', method + ' ' + p);
    }
  }
  const post = await on.req('POST', '/key', {});
  assert.notEqual(post.status, 302);
  assert.equal(post.status, (await on.req('POST', '/nothing-here', {})).status, 'the same answer as any unknown path');
  const off = await boot(t, { signin: 'off' });
  const gone = await off.req('GET', '/key');
  assert.equal(gone.status, 404);
  assert.equal(gone.status, (await off.req('GET', '/nothing-here')).status);
  assert.equal(gone.body, (await off.req('GET', '/nothing-here')).body, 'not a special answer');
});

test('MCP: any use of an agent key refreshes it, so daily join_room use keeps it alive past 90 days; an unused one idles out', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const used = await mintKey(h, s);
  const made = toolOut(await mcpCall(h, 'create_room', mcpRoom, bearer(used)));
  const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');
  const born = h.keys.get(sha(used)).lastUsedAt;
  for (let day = 1; day <= 100; day++) {
    h.clock.t += DAY;
    assert.notEqual((await mcpCall(h, 'get_room', { link: made.your_link }, bearer(used))).json.result.isError, true);
  }
  assert.ok(h.keys.get(sha(used)).lastUsedAt > born + 99 * DAY, 'lastUsedAt moved with the use');
  const again = await mcpCall(h, 'create_room', mcpRoom, bearer(used));
  assert.notEqual(again.json.result.isError, true, 'still alive after 100 days: it counts from the last use, not the last create_room');
  // Without the daily use, the same key dies.
  const idle = await mintKey(h, s);
  h.clock.t += 91 * DAY;
  assert.equal(toolText(await mcpCall(h, 'create_room', mcpRoom, bearer(idle))), KEY_REJECTED);
});

test('MCP: the Authorization scheme is case-insensitive (RFC 7235); a double space or a tab after it is refused, on purpose', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const key = await mintKey(h, s);
  for (const header of [`bearer ${key}`, `BEARER ${key}`, `Bearer ${key}`]) {
    const r = await mcpCall(h, 'create_room', mcpRoom, { authorization: header });
    assert.notEqual(r.json.result.isError, true, header.slice(0, 8));
  }
  const before = h.app.domain.rooms.size;
  for (const header of [`Bearer  ${key}`, `Bearer\t${key}`, `Bearer ${key} x`]) {
    const r = await mcpCall(h, 'create_room', mcpRoom, { authorization: header });
    assert.equal(toolText(r), KEY_REJECTED, JSON.stringify(header.slice(0, 9)));
  }
  assert.equal(h.app.domain.rooms.size, before);
});

test('POST /api/rooms reads the session again after the body: a logout or a vanished user while the body is arriving is a 401', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h);
  const slow = (before) => new Promise((resolve, reject) => {
    const u = new URL(h.base);
    const payload = JSON.stringify(roomBody);
    const req = http.request({ host: u.hostname, port: u.port, method: 'POST', path: '/api/rooms', headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), cookie: s.cookie } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(payload.slice(0, 10));
    setTimeout(async () => { try { await before(); } catch (e) { reject(e); return; } req.end(payload.slice(10)); }, 100);
  });
  const ok = await slow(async () => {});
  assert.equal(ok.status, 201, ok.text);
  const out = await slow(async () => { assert.equal((await h.post('/auth/logout', { cookie: s.cookie })).status, 204); });
  assert.equal(out.status, 401, out.text);
  assert.equal(JSON.parse(out.text).code, 'signin_required');
  assert.equal(h.app.domain.rooms.size, 1, 'no room was made');
  assert.equal(h.app.store.state.usage.byUser['1001'], 1, 'and nothing was counted');
  // A user that vanished (or was blocked) mid-body: the session is still there, its user is not.
  const s2 = await signIn(h);
  const gone = await new Promise((resolve, reject) => {
    const u = new URL(h.base);
    const payload = JSON.stringify(roomBody);
    const req = http.request({ host: u.hostname, port: u.port, method: 'POST', path: '/api/rooms', headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), cookie: s2.cookie } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(payload.slice(0, 10));
    setTimeout(() => { h.users.delete('1001'); req.end(payload.slice(10)); }, 100);
  });
  assert.equal(gone.status, 401, gone.text);
  assert.equal(h.app.domain.rooms.size, 1);
});

test('sign-in off: web and MCP create exactly as before: no user, no owner, no per-user count, and a bearer header is ignored', T, async (t) => {
  const h = await boot(t, { signin: 'off', extra: { PER_USER_DAILY: '1' } });
  const web = await h.post('/api/rooms', { type: 'application/json', origin: null, body: roomBody });
  assert.equal(web.status, 201, web.text);
  assert.deepEqual(Object.keys(web.json).sort(), ['id', 'links', 'modes']);
  const a = await mcpCall(h, 'create_room', mcpRoom);
  const b = await mcpCall(h, 'create_room', mcpRoom, bearer('bh_anything-at-all'));
  const c = await mcpCall(h, 'create_room', mcpRoom, bearer('bh_anything-at-all'));
  for (const r of [a, b, c]) assert.notEqual(r.json.result.isError, true, toolText(r));
  const shape = (r) => JSON.stringify(r.json).split(toolOut(r).room_id).join('ID').replace(/t=[A-Za-z0-9_-]+/g, 't=T');
  assert.equal(shape(a), shape(b));
  assert.equal(shape(b), shape(c));
  for (const room of h.app.domain.rooms.values()) assert.ok(!('ownerId' in room));
  assert.equal(h.app.domain.rooms.size, 4, 'a per-user limit of 1 does not apply');
  assert.equal(Object.keys(h.app.store.state.usage.byUser).length, 0);
  const given = h.app.domain.createLiveRoom('203.0.113.1', roomBody, { id: '7', login: 'x' });
  assert.ok(!('ownerId' in given), 'a user handed to a server with sign-in off is ignored');
  assert.equal(Object.keys(h.app.store.state.usage.byUser).length, 0);
  assert.equal(h.app.ops.userForAgentKey('bh_anything-at-all'), null);
  assert.equal(h.app.ops.userForAgentKey(undefined), null);
});

test('the owner id never appears in anything a client is sent: views of both seats and the demo, the ledger, the brief, SSE and the MCP results', T, async (t) => {
  const OWNER = '987654321';
  const h = await boot(t, { gh: fakeGithub({ id: Number(OWNER) }) });
  const s = await signIn(h);
  const key = await mintKey(h, s);
  const made = toolOut(await mcpCall(h, 'create_room', mcpRoom, bearer(key)));
  const room = h.app.domain.rooms.get(made.room_id);
  assert.equal(room.ownerId, OWNER);
  assert.ok(JSON.stringify(room).includes(OWNER), 'the owner is on the stored room (so the absence below means something)');
  const seen = [JSON.stringify(made)];
  const call = async (name, args) => { const r = await mcpCall(h, name, args); assert.notEqual(r.json.result.isError, true, toolText(r)); seen.push(r.text); return toolOut(r); };
  const card = (n) => ({ principal: { name: n }, goal: 'g', must_haves: ['m'] });
  await call('join_room', { link: made.your_link, agent_name: 'A' });
  await call('join_room', { link: made.invite_link_for_counterpart, agent_name: 'B' });
  await call('seal_intent_card', { link: made.your_link, card: card('Ann') });
  await call('seal_intent_card', { link: made.invite_link_for_counterpart, card: card('Ben') });
  await call('send_envelope', { link: made.your_link, message: 'm', status: 'continue', proposal: { terms: ['the term'], depends_on: [] } });
  await call('send_envelope', { link: made.invite_link_for_counterpart, message: 'ok', status: 'agree' });
  assert.equal(room.status, 'agreed');
  assert.ok(room.brief, 'there is a brief');
  await call('get_room', { link: made.your_link });
  await call('get_brief', { room_id: made.room_id });
  await call('get_brief', { link: made.invite_link_for_counterpart });
  const web = (p) => h.req('GET', p);
  for (const seat of ['A', 'B']) {
    const r = await web(`/api/rooms/${room.id}?seat=${seat}&t=${room.seats[seat].token}`);
    assert.equal(r.status, 200);
    seen.push(r.text);
  }
  seen.push((await web(`/api/rooms/${room.id}`)).text);
  seen.push((await web(`/api/rooms/${room.id}/ledger`)).text);
  // A web-made room, and the demo.
  const webRoom = await h.post('/api/rooms', { cookie: s.cookie, body: roomBody });
  seen.push(webRoom.text, (await web(`/api/rooms/${webRoom.json.id}?seat=A&t=${h.app.domain.rooms.get(webRoom.json.id).seats.A.token}`)).text);
  const demo = await h.post('/api/demo', {});
  seen.push(demo.text, (await web(`/api/rooms/${demo.json.id}?seat=A&t=${demo.json.token}`)).text);
  // The first event of the stream.
  const sse = await new Promise((resolve, reject) => {
    const u = new URL(h.base);
    const req = http.request({ host: u.hostname, port: u.port, path: `/api/rooms/${room.id}/events?seat=A&t=${room.seats.A.token}` }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.includes('\n\n')) { req.destroy(); resolve(data); } });
      res.on('error', () => resolve(data));
    });
    req.on('error', () => resolve(''));
    req.end();
  });
  seen.push(sse);
  assert.ok(sse.length > 0, 'the stream sent something');
  assert.ok(seen.length >= 14 && seen.every((x) => typeof x === 'string' && x.length > 0));
  for (const text of seen) assert.ok(!text.includes(OWNER), 'the owner id leaked: ' + text.slice(0, 200));
  assert.ok(!/ownerId/.test(seen.join('')));
});

test('end to end over real HTTP with a fake GitHub: login, mint, MCP create_room is owned and counted on the user, a second user behind the same address is not limited by it, a revoked key is refused', T, async (t) => {
  const h = await boot(t, { extra: { PER_IP_DAILY: '1', PER_USER_DAILY: '2', DAILY_ROOM_LIMIT: '50' } });
  const { usage } = h.app.store.state;
  const ann = await signIn(h);
  assert.equal((await h.req('GET', '/api/me', { headers: { cookie: ann.cookie } })).json.user.login, 'octocat');
  const annMade = await mintMade(h, ann);
  const annKey = annMade.key;
  const first = await mcpCall(h, 'create_room', mcpRoom, bearer(annKey));
  assert.notEqual(first.json.result.isError, true, toolText(first));
  assert.equal(h.app.domain.rooms.get(toolOut(first).room_id).ownerId, '1001');
  assert.deepEqual(Object.assign({}, usage.byUser), { 1001: 1 });
  assert.deepEqual(Object.assign({}, usage.byIp), {}, 'counted on the user, not the address');
  // PER_IP_DAILY is 1 and every request here comes from 127.0.0.1: a second room for the same user is still fine.
  assert.notEqual((await mcpCall(h, 'create_room', mcpRoom, bearer(annKey))).json.result.isError, true);
  // A second account, same address.
  h.gh.id = 1002; h.gh.login = 'hubot';
  const ben = await signIn(h);
  assert.notEqual(ben.session, ann.session);
  const benKey = await mintKey(h, ben);
  const benRoom = await mcpCall(h, 'create_room', mcpRoom, bearer(benKey));
  assert.notEqual(benRoom.json.result.isError, true, toolText(benRoom));
  assert.equal(h.app.domain.rooms.get(toolOut(benRoom).room_id).ownerId, '1002');
  assert.equal((await h.post('/api/rooms', { cookie: ben.cookie, body: roomBody })).status, 201);
  assert.deepEqual(Object.assign({}, usage.byUser), { 1001: 2, 1002: 2 });
  assert.deepEqual(Object.assign({}, usage.byIp), {});
  assert.equal(usage.total, 4);
  // Ann is at her limit and Ben's is a separate count.
  assert.equal(toolText(await mcpCall(h, 'create_room', mcpRoom, bearer(annKey))), 'You have opened the maximum live rooms for today. The demo is unlimited.');
  // Revoking Ann's key ends it, and Ben's still works for his own limit-free tools.
  assert.equal((await revokeKid(h, ann, annMade.kid)).status, 204);
  const after = await mcpCall(h, 'create_room', mcpRoom, bearer(annKey));
  assert.equal(after.json.result.isError, true);
  assert.equal(toolText(after), KEY_REJECTED);
  assert.equal(usage.total, 4, 'the refusals counted nothing');
  assert.deepEqual(Object.assign({}, usage.byUser), { 1001: 2, 1002: 2 });
});

test('MCP create_room: a user or owner smuggled in as tool arguments is not a user, with no key and with a key', T, async (t) => {
  const h = await boot(t);
  const forged = { ...mcpRoom, user: { id: '42', login: 'x' }, user_id: '42', ownerId: '42', owner: '42' };
  assert.equal(toolText(await mcpCall(h, 'create_room', forged)), KEY_MISSING);
  assert.equal(h.app.domain.rooms.size, 0);
  const s = await signIn(h);
  const r = await mcpCall(h, 'create_room', forged, bearer(await mintKey(h, s)));
  assert.notEqual(r.json.result.isError, true, toolText(r));
  assert.equal(h.app.domain.rooms.get(toolOut(r).room_id).ownerId, '1001');
  assert.deepEqual(Object.assign({}, h.app.store.state.usage.byUser), { 1001: 1 });
});

test('the owner id is in no SSE event, for either seat, at any point of a negotiation run through the real server, nor in /api/me, /api/config or /health', T, async (t) => {
  const OWNER = '987654321';
  const { openSse } = require('../test-support/sse');
  const h = await boot(t, { gh: fakeGithub({ id: Number(OWNER) }) });
  const s = await signIn(h);
  const key = await mintKey(h, s);
  const made = toolOut(await mcpCall(h, 'create_room', mcpRoom, bearer(key)));
  const room = h.app.domain.rooms.get(made.room_id);
  assert.equal(room.ownerId, OWNER);
  const streams = ['A', 'B'].map((seat) => openSse(h.base, `/api/rooms/${room.id}/events?seat=${seat}&t=${room.seats[seat].token}`));
  const spectator = openSse(h.base, `/api/rooms/${room.id}/events`);
  t.after(() => { for (const x of [...streams, spectator]) x.close(); });
  await streams[0].next(0); await streams[1].next(0);
  const card = (n) => ({ principal: { name: n }, goal: 'g', must_haves: ['m'] });
  const call = async (name, args) => { const r = await mcpCall(h, name, args); assert.notEqual(r.json.result.isError, true, toolText(r)); };
  await call('join_room', { link: made.your_link, agent_name: 'A' });
  await call('join_room', { link: made.invite_link_for_counterpart, agent_name: 'B' });
  await call('seal_intent_card', { link: made.your_link, card: card('Ann') });
  await call('seal_intent_card', { link: made.invite_link_for_counterpart, card: card('Ben') });
  await call('send_envelope', { link: made.your_link, message: 'm', status: 'continue', proposal: { terms: ['the term'], depends_on: [] } });
  await call('send_envelope', { link: made.invite_link_for_counterpart, message: 'ok', status: 'agree' });
  assert.equal(room.status, 'agreed');
  for (const x of streams) await x.drain();
  const seen = [];
  for (const x of streams) { assert.ok(x.events.length >= 3, 'the stream followed the whole negotiation: ' + x.events.length); seen.push(...x.events.map((e) => e.text)); }
  assert.ok(streams.every((x) => x.events.at(-1).json.status === 'agreed'), 'a stream saw the agreement');
  await spectator.drain(); seen.push(...spectator.events.map((e) => e.text));
  for (const p of ['/api/me', '/api/config', '/health']) seen.push((await h.req('GET', p, { headers: { cookie: s.cookie } })).text);
  seen.push((await h.req('POST', '/mcp', { headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).text);
  for (const text of seen) assert.ok(!text.includes(OWNER) && !/ownerId/.test(text), 'the owner id leaked: ' + text.slice(0, 200));
});

// ---------- the whole file's logs ----------
test('every log line the sign-in tests produced is plain: no secret, token, code, state, login or id, and only allowed fields', () => {
  assert.ok(ALL_LOGS.length > 20, 'there are logs to look at: ' + ALL_LOGS.length);
  const allowedKeys = new Set(['level', 'event', 'room', 'seat', 'status', 'httpStatus', 'errorClass', 'code', 'durationMs', 'stack', 'reason', 'kind']);
  const forbidden = [GH_TOKEN, CLIENT_SECRET, CLIENT_ID, 'good-code', 'octocat', 'GHTEXT', 'bh_', 'gho_', 'bad_verification_code', '@b.test'];
  for (const line of ALL_LOGS) {
    for (const f of forbidden) assert.ok(!line.includes(f), `logged ${f}: ${line}`);
    const noStack = line.replace(/ stack="(?:[^"\\]|\\.)*"/, ''); // file paths of the checkout can be long, and are not a token
    assert.ok(!/[A-Za-z0-9_-]{43}/.test(noStack), 'a token-shaped string: ' + line);
    const bare = line.replace(/"(?:[^"\\]|\\.)*"/g, '""'); // the keys only, not what is inside a value
    for (const m of bare.matchAll(/(?:^| )([A-Za-z]+)=/g)) assert.ok(allowedKeys.has(m[1]), 'a field that is not allowed: ' + m[1]);
  }
});

test('a logout or revoke refused because the store was failing is still owed after it recovers: the repeat writes it, and only then says done', T, async (t) => {
  const h = mkAuth(t);
  const { token } = await login(h);
  const user = h.auth.userForSession(token);
  const { kid } = await h.auth.mintAgentKey(user, '');
  h.store.failing = true;
  assert.equal(await h.auth.logout(token), false);
  assert.equal(await h.auth.revokeAgentKey(user, kid), false);
  h.store.failing = false;
  h.store.persistCalls.length = 0;
  assert.equal(await h.auth.logout(token), true);
  assert.deepEqual(h.store.persistCalls, [['session', sha256(token)]], 'the logout is written on the repeat');
  h.store.persistCalls.length = 0;
  assert.equal(await h.auth.revokeAgentKey(user, kid), true);
  assert.equal(h.store.persistCalls.length, 1, 'and so is the revoke');
  assert.equal(h.store.persistCalls[0][0], 'agentkey');
});

// ---------- the web pages' side of the API: the real browser library and view modules against the real server ----------
const BrowserUI = require('../web/ui/ui.js');
const AccountView = require('../web/js/account-view.js');
const RoomView = require('../web/js/room-view.js');
const AdminView = require('../web/js/admin-view.js');
const { EXPECTED } = require('../test-support/refusals');
const { loadPage } = require('../test-support/fake-page');

// UI.request over the in-process server, as a browser on PUBLIC would send it: same-origin Origin and the session cookie.
async function asBrowser(h, cookie, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  globalThis.fetch = async (url, init = {}) => {
    const headers = { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(init.headers || {}) };
    if (init.body !== undefined) headers['content-length'] = Buffer.byteLength(init.body);
    const r = await h.req(init.method || 'GET', url, { headers, body: init.body });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => { if (r.json === null) throw new SyntaxError('no JSON'); return r.json; } };
  };
  try { return await fn(); } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved); else delete globalThis.fetch;
  }
}

test('the pages talk to the real server: /api/me, the agent key panel, UI.request with no body, and sign out, all as the scripts use them', T, async (t) => {
  const h = await boot(t);
  const out = await asBrowser(h, null, () => BrowserUI.request('GET', '/api/me'));
  assert.deepEqual(AccountView.parseMe(out.data), { signin: 'github', user: null, agentKeys: [], ai: 'none', admin: false });
  assert.equal(AccountView.slot(AccountView.parseMe(out.data), '/connect').kind, 'signed-out');
  assert.equal((await asBrowser(h, null, () => BrowserUI.loadConfig())).signin, 'github');

  const s = await signIn(h, { next: '/connect' });
  await asBrowser(h, s.cookie, async () => {
    const me = AccountView.parseMe((await BrowserUI.request('GET', '/api/me')).data);
    assert.deepEqual(me, { signin: 'github', user: { login: 'octocat' }, agentKeys: [], ai: 'none', admin: false });
    assert.deepEqual(AccountView.slot(me, '/connect'), { kind: 'signed-in', who: 'octocat', hint: 'Signed in as ', signOut: 'Sign out' });
    assert.equal(AccountView.keyPanel(me, null, '/connect').state, 'no-key');

    // Make a key the way connect.js does: the name is always sent, '' for none (a body without it is refused).
    assert.equal((await BrowserUI.request('POST', '/api/me/agent-key', {})).status, 400);
    const made = await BrowserUI.request('POST', '/api/me/agent-key', { name: '' });
    assert.equal(made.status, 201, JSON.stringify(made));
    assert.match(made.data.key, /^bh_/);
    assert.equal(typeof made.data.createdAt, 'number');
    assert.match(made.data.kid, /^[0-9a-f]{12}$/);
    const after = AccountView.parseMe((await BrowserUI.request('GET', '/api/me')).data);
    assert.deepEqual(after.agentKeys, [{ kid: made.data.kid, name: null, createdAt: made.data.createdAt, lastUsedAt: null }]);
    const panel = AccountView.keyPanel(after, null, '/connect');
    assert.equal(panel.state, 'has-key');
    assert.deepEqual(panel.keys.map((k) => [k.kid, k.label, k.lastUsed]), [[made.data.kid, 'Agent key (created ' + AccountView.formatDate(made.data.createdAt) + ', ' + made.data.kid.slice(0, 4) + ')', 'Not used yet']]);
    assert.equal(AccountView.keyPanel(after, made.data, '/connect').state, 'new-key');
    // The command the page shows for that key carries the header MCP reads, and the server knows the key.
    assert.match(RoomView.mcpCommand('https://behalf.test', made.data.key), /--header "Authorization: Bearer bh_/);
    assert.deepEqual(h.app.auth.userForAgentKey(made.data.key), { id: '1001', login: 'octocat' });

    const revoked = await BrowserUI.request('POST', '/api/me/agent-key/revoke', { kid: made.data.kid });
    assert.deepEqual(revoked, { ok: true, status: 204, data: {} });
    assert.equal(h.app.auth.userForAgentKey(made.data.key), null);
    assert.deepEqual(AccountView.parseMe((await BrowserUI.request('GET', '/api/me')).data).agentKeys, []);

    const loggedOut = await BrowserUI.request('POST', '/auth/logout', {});
    assert.deepEqual(loggedOut, { ok: true, status: 204, data: {} });
  });
  // The same POST without the library's content type is what the server refuses: the library fix is what makes the buttons work.
  assert.equal((await h.post('/auth/logout', { cookie: s.cookie, type: null })).status, 415);
  // The sign-in link the slot builds is a route the server serves, and it comes back to the page it was on.
  const link = await h.req('GET', AccountView.signinHref('/connect'));
  assert.equal(link.status, 302);
  assert.match(cookieValue(link, OAUTH), /\.\/connect$/);
});

test('every coded refusal the server source names for a web action is provoked over real HTTP, and the page has a sentence of its own for it', T, async (t) => {
  const seen = new Set();
  const ACCOUNT = ['logout', 'keyCreate', 'keyRevoke'];
  const ACCOUNT_VIEW = [...ACCOUNT, 'aiRequest'];
  const sentence = (a, s, c) => (a === 'adminDecide' ? AdminView : (ACCOUNT_VIEW.includes(a) ? AccountView : RoomView)).errorMessage(a, s, c);
  const check = (action, res) => {
    const body = res.json || {};
    assert.equal(typeof body.code, 'string', `${action}: ${res.status} ${res.text} carries no code`);
    const own = sentence(action, res.status, body.code);
    assert.notEqual(own, sentence(action, res.status), `${action} ${res.status} ${body.code}: no sentence of its own`);
    assert.ok(!own.includes(body.error), 'the server text is not what the page shows');
    seen.add(`${action} ${res.status} ${body.code}`);
  };
  const h = await boot(t, { extra: { PER_USER_DAILY: '1', DAILY_ROOM_LIMIT: '2' } });
  const s = await signIn(h);
  // the guards, on every action behind them
  const posts = { create: '/api/rooms', logout: '/auth/logout', keyCreate: '/api/me/agent-key', keyRevoke: '/api/me/agent-key/revoke' };
  for (const [action, p] of Object.entries(posts)) {
    check(action, await h.post(p, { cookie: s.cookie, origin: 'https://evil.test', body: roomBody }));
    check(action, await h.post(p, { cookie: s.cookie, type: 'text/plain', body: roomBody }));
  }
  // signed out (logout needs no session, so it has no 401)
  for (const action of ['create', 'keyCreate', 'keyRevoke']) check(action, await h.post(posts[action], { body: roomBody }));
  // the account's own limit, then the whole service's
  assert.equal((await h.post('/api/rooms', { cookie: s.cookie, body: roomBody })).status, 201);
  check('create', await h.post('/api/rooms', { cookie: s.cookie, body: roomBody }));
  h.gh.id = 1002; h.gh.login = 'second';
  const s2 = await signIn(h);
  assert.equal((await h.post('/api/rooms', { cookie: s2.cookie, body: roomBody })).status, 201);
  h.gh.id = 1003; h.gh.login = 'third';
  const s3 = await signIn(h);
  check('create', await h.post('/api/rooms', { cookie: s3.cookie, body: roomBody }));
  // minting is the one rate-limited route (a refused name or count is answered before the rate is asked)
  const kids = [];
  for (let i = 0; i < 10; i++) { const r = await h.post('/api/me/agent-key', { cookie: s3.cookie }); assert.equal(r.status, 201); kids.push(r.json.kid); }
  assert.equal((await revokeKid(h, s3, kids[0])).status, 204);
  check('keyCreate', await h.post('/api/me/agent-key', { cookie: s3.cookie }));
  // ten live keys is as many as one account keeps (the rate window has to pass first)
  h.clock.t += 11 * 60 * 1000;
  assert.equal((await h.post('/api/me/agent-key', { cookie: s3.cookie })).status, 201);
  check('keyCreate', await h.post('/api/me/agent-key', { cookie: s3.cookie }));
  // the name: too long, and one the account already has
  check('keyCreate', await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'x'.repeat(41) } }));
  assert.equal((await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'Claude Code' } })).status, 201);
  check('keyCreate', await h.post('/api/me/agent-key', { cookie: s.cookie, body: { name: 'claude code' } }));
  const own = await mintMade(h, s2);
  // saving has been failing: each action that has to save says so
  h.store.failing = true;
  check('create', await h.post('/api/rooms', { cookie: s2.cookie, body: roomBody }));
  check('keyCreate', await h.post('/api/me/agent-key', { cookie: s2.cookie }));
  check('keyRevoke', await revokeKid(h, s2, own.kid));
  check('logout', await h.post('/auth/logout', { cookie: s2.cookie }));
  // the built-in AI needs "Use our AI" access (the proxy has to be live for the question to come up)
  const live = await boot(t, { proxy: { ...fakeProxy(), live: () => true } });
  const liveUser = await signIn(live);
  check('create', await live.post('/api/rooms', { cookie: liveUser.cookie, body: { ...roomBody, modeB: 'builtin' } }));
  // a room opened without it (two own agents) cannot draft with our AI either
  const closed = await live.post('/api/rooms', { cookie: liveUser.cookie, body: roomBody });
  assert.equal(closed.status, 201);
  const closedToken = new URL(closed.json.links.A, PUBLIC).searchParams.get('t');
  check('draft', await live.post('/api/rooms/' + closed.json.id + '/seats/A/draft', { origin: null, body: { token: closedToken, text: 'a brief', name: 'Ann' } }));
  // asking for "Use our AI": the guards, signed out, the note, the rate (5 per user), and a full queue (500 waiting)
  const q = await boot(t);
  const qa = await signIn(q);
  q.gh.id = 1002; q.gh.login = 'second';
  const qb = await signIn(q);
  const ask = '/api/me/ai-access';
  check('aiRequest', await q.post(ask, { cookie: qa.cookie, origin: 'https://evil.test' }));
  check('aiRequest', await q.post(ask, { cookie: qa.cookie, type: 'text/plain' }));
  check('aiRequest', await q.post(ask, {}));
  check('aiRequest', await q.post(ask, { cookie: qa.cookie, body: { note: 'x'.repeat(300) } }));
  for (let i = 0; i < 5; i++) assert.equal((await q.post(ask, { cookie: qa.cookie, body: { note: 'please' } })).status, 200);
  check('aiRequest', await q.post(ask, { cookie: qa.cookie, body: { note: 'please' } }));
  for (let i = 0; i < 500; i++) q.app.aiAccess.request({ id: String(7000 + i), login: 'bulk' + i }, '');
  check('aiRequest', await q.post(ask, { cookie: qb.cookie, body: { note: 'late' } }));
  // an admin's decision: the guards (a non-admin gets a 404 before them), and a store that cannot save
  const boss = await boot(t, { extra: { ADMIN_GITHUB_IDS: '1001' } });
  const bossSession = await signIn(boss);
  boss.gh.id = 1002; boss.gh.login = 'second';
  await signIn(boss);
  const decide = '/api/admin/ai-access';
  check('adminDecide', await boss.post(decide, { cookie: bossSession.cookie, origin: 'https://evil.test', body: { userId: '1002', decision: 'grant' } }));
  check('adminDecide', await boss.post(decide, { cookie: bossSession.cookie, type: 'text/plain', body: { userId: '1002', decision: 'grant' } }));
  boss.store.failing = true;
  check('adminDecide', await boss.post(decide, { cookie: bossSession.cookie, body: { userId: '1002', decision: 'grant' } }));
  // the address's own limit exists only with sign-in off
  const off = await boot(t, { signin: 'off', extra: { PER_IP_DAILY: '1' } });
  assert.equal((await off.post('/api/rooms', { origin: null, body: roomBody })).status, 201);
  check('create', await off.post('/api/rooms', { origin: null, body: roomBody }));
  // Every coded refusal the hand-written table lists for these actions was provoked (a draft's shutting_down needs a stopping server).
  const wanted = [];
  for (const action of ['create', 'logout', 'keyCreate', 'keyRevoke', 'aiRequest', 'adminDecide']) for (const [status, code] of EXPECTED[action]) wanted.push(`${action} ${status} ${code}`);
  for (const [status, code] of EXPECTED.draft) if (code !== 'shutting_down') wanted.push(`draft ${status} ${code}`);
  assert.deepEqual([...seen].sort(), wanted.sort(), 'every coded (action, status, code) of EXPECTED was provoked');
});

test('the real page scripts, over real HTTP: the key buttons and sign-out work (JSON POSTs, not 415s), and the panel follows what the server did', T, async (t) => {
  const h = await boot(t);
  const s = await signIn(h, { next: '/connect' });
  await asBrowser(h, s.cookie, async () => {
    const page = loadPage({ request: (m, u, b) => BrowserUI.request(m, u, b), config: { live: true, passcode: false, signin: 'github' }, origin: PUBLIC });
    await page.flush();
    assert.ok(page.byId('key-create'), 'signed in, no key');
    page.byId('key-name').value = 'Claude Code';
    page.byId('key-name').fire('input');
    page.byId('key-create').click();
    await page.flush();
    const key = page.byId('agent-key').value;
    assert.match(key, /^bh_/);
    assert.deepEqual(h.app.auth.userForAgentKey(key), { id: '1001', login: 'octocat' }, 'the server made it');
    const [{ kid, name }] = h.app.auth.agentKeysInfo({ id: '1001' });
    assert.equal(name, 'Claude Code', 'with the name that was typed');
    page.byId('key-delete-' + kid).click();
    await page.flush();
    assert.equal(h.app.auth.userForAgentKey(key), null, 'the server deleted it');
    assert.ok(!page.panelHtml().includes('id="agent-key"'));
    assert.deepEqual(page.toasts, [['Claude Code no longer works.', 'ok']]);
    page.byId('sign-out').click();
    await page.flush();
    assert.equal(h.app.auth.userForSession(s.session), null, 'the server ended the session');
    assert.ok(page.slotHtml().includes('id="account-signin"'));
  });
  // a script that sent no body would be refused: this is what the server says to it
  await asBrowser(h, (await signIn(h)).cookie, async () => {
    for (const p of ['/api/me/agent-key', '/api/me/agent-key/revoke', '/auth/logout']) {
      const r = await BrowserUI.request('POST', p);
      assert.deepEqual([r.status, r.data.code], [415, 'content_type'], p);
    }
  });
});
