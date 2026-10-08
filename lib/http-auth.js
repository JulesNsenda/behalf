'use strict';
// The sign-in part of the HTTP layer: the cookies, the guards and the routes /auth/* and /api/me*. lib/http.js dispatches to it.
// createAuthRoutes({ auth, aiAccess, publicUrl, log, clientIp, send, readObject }) -> { handleAuth, handleMe, handleAdmin, requireUser }.
// `auth` (lib/auth.js) and `aiAccess` (lib/ai-access.js) are null with sign-in off: then only GET /api/me answers (as signed out, with
// ai 'none' and admin false) and nothing else here exists; lib/http.js does not even dispatch /api/admin/* then. readObject(req, limit) reads a
// JSON object body (lib/http.js); the key routes re-run requireUser after it, as POST /api/rooms does.
//  - handleAuth(req, res, url): /auth/github, /auth/github/callback and POST /auth/logout. Always answers.
//  - handleAdmin(req, res, parts): GET and POST /api/admin/ai-access (below); 404 for anyone who is not an admin, POST included (a
//    non-admin never sees a 401, 403 or 415 from it).
//  - handleMe(req, res, parts): /api/me (with agentKeys: the user's live keys; ai: 'granted' | 'requested' | 'denied' | 'none', the
//    "Use our AI" status; admin: bool), POST /api/me/ai-access {note?} (200 { status }; 400 ai_note, 429 rate_limited, 503
//    requests_full), POST /api/me/agent-key {name} (201 { key, kid, name,
//    createdAt }; name is required, '' for none, so a page from before names cannot mint by mistake: without it 400 with no code;
//    400 key_name or key_name_taken; 409 key_limit) and POST /api/me/agent-key/revoke {kid} (204; 400 for a kid that is missing or
//    malformed), by `${method} /${sub}`. Resolves
//    true when it answered, false when the request is none of its routes (the caller carries on as for any other path).
//  - requireUser(req): the signed-in user ({ id, login }) for a cookie-authenticated request, or an ApiError (403, 415, 401).
// Two cookies, both __Host-, HttpOnly, Secure, SameSite=Lax: the OAuth state (10 min) and the session (30 days). The session is only
// read by the cookie-authenticated branches, each of which calls requireUser itself, after routing, so no path spelling can skip it:
// it needs an Origin equal to PUBLIC_URL's (a missing one, or 'null', is refused), a JSON content type (which a cross-site form cannot
// send and a cross-origin script cannot send without a preflight this server does not grant) and a valid session. /mcp never reads a
// cookie. Every Location here is relative, except the one to GitHub. A cookie name that is repeated, or padded, counts as absent.
// Durability and rates: logout, mint and revoke take effect in memory at once and only report whether they are durable: a 503
// ("saving_unavailable") means "not saved yet", and logout clears the cookie anyway. They refuse while the store is failing with no
// grace on purpose (a revocation that cannot be saved must not look done), unlike room creation, which keeps working for a minute.
// Only minting is rate-limited (10 per user per 10 minutes); logout and revoke always work.
const { ApiError, AuthError, savingUnavailable, signinRequired } = require('./errors');
const { MAX_KEYS_PER_USER, KEY_NAME_MAX, KID } = require('./auth');
const { NOTE_MAX } = require('./ai-access');

const OAUTH_COOKIE = '__Host-behalf_oauth';
const SESSION_COOKIE = '__Host-behalf_session';
const OAUTH_MAX_AGE = 600;
const SESSION_MAX_AGE = 30 * 24 * 3600;
const RATE_LIMITED = 'Too many requests. Try again in a few minutes.';
const NAME_LENGTH = `A key name is at most ${KEY_NAME_MAX} characters.`;
const NAME_TAKEN = 'A key with that name already exists.';
const KEY_LIMIT = `You can keep ${MAX_KEYS_PER_USER} agent keys. Delete one you no longer use first.`;
const NOTE_LENGTH = `A note is at most ${NOTE_MAX} characters, as plain text.`;
const REQUESTS_FULL = 'Too many requests are waiting for approval right now. Try again later.';
const BODY_LIMIT = 4096; // the key routes' and the AI-access routes' bodies are one short field
const USER_ID = /^[0-9]{1,15}$/; // a GitHub numeric id
const DECISIONS = ['grant', 'deny', 'reset'];

// The value of the cookie `name` in a Cookie header, or null. Not decoded. A name that appears more than once, or that only
// matches after its padding is trimmed, is as good as absent: which of two copies is meant is not for this server to guess.
function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  let value = null;
  let seen = 0;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const raw = part.slice(0, i).replace(/^[ \t]+/, ''); // the space after the ';' separator is not padding
    if (raw.trim() !== name) continue;
    if (raw !== name) return null;
    seen++;
    value = part.slice(i + 1).trim();
  }
  return seen === 1 ? value : null;
}

// A Set-Cookie value. The __Host- prefix needs Secure, Path=/ and no Domain.
const setCookie = (name, value, maxAge) => `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const clearCookie = (name) => setCookie(name, '', 0);

// The OAuth cookie holds state.verifier.next; none of the three contains a dot.
function parseOauthCookie(value) {
  const parts = typeof value === 'string' ? value.split('.') : [];
  return parts.length === 3 ? { state: parts[0], verifier: parts[1], next: parts[2] } : null;
}

// The error for a refused mint: { ok: false, reason } from checkMint or mintAgentKey.
function refused(r) {
  if (r.reason === 'name') return new ApiError(400, NAME_LENGTH, 'key_name');
  if (r.reason === 'name_taken') return new ApiError(400, NAME_TAKEN, 'key_name_taken');
  if (r.reason === 'limit') return new ApiError(409, KEY_LIMIT, 'key_limit');
  return savingUnavailable();
}

// The error for a refused request for "Use our AI": { ok: false, reason } from aiAccess.request.
function askRefused(r) {
  if (r.reason === 'note') return new ApiError(400, NOTE_LENGTH, 'ai_note');
  if (r.reason === 'rate') return new ApiError(429, RATE_LIMITED, 'rate_limited');
  return new ApiError(503, REQUESTS_FULL, 'requests_full');
}

function createAuthRoutes({ auth, aiAccess, publicUrl, log, clientIp, send, readObject }) {
  const publicOrigin = auth ? new URL(publicUrl).origin : null;
  const sessionToken = (req) => readCookie(req.headers.cookie, SESSION_COOKIE);

  function guard(req) {
    if (req.headers.origin !== publicOrigin) throw new ApiError(403, 'Request not allowed from this origin.', 'origin');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new ApiError(415, 'Content-Type must be application/json.', 'content_type');
  }

  function requireUser(req) {
    guard(req);
    const user = auth.userForSession(sessionToken(req));
    if (!user) throw signinRequired();
    return user;
  }

  async function handleAuth(req, res, url) {
    const { pathname } = url;
    if (req.method === 'GET' && pathname === '/auth/github') {
      const login = auth.beginLogin(url.searchParams.get('next'));
      return send(res, 302, '', { location: login.location, 'set-cookie': setCookie(OAUTH_COOKIE, `${login.state}.${login.verifier}.${login.next}`, OAUTH_MAX_AGE) });
    }
    if (req.method === 'GET' && pathname === '/auth/github/callback') {
      const q = url.searchParams;
      const expected = parseOauthCookie(readCookie(req.headers.cookie, OAUTH_COOKIE));
      try {
        const out = await auth.completeLogin({ code: q.get('code'), state: q.get('state'), expected, previousToken: sessionToken(req), ip: clientIp(req) });
        return send(res, 302, '', { location: out.next, 'set-cookie': [setCookie(SESSION_COOKIE, out.token, SESSION_MAX_AGE), clearCookie(OAUTH_COOKIE)] });
      } catch (e) {
        if (!(e instanceof AuthError)) log.error('http.unexpected', {}, e); // an AuthError has been logged by auth
        return send(res, 302, '', { location: '/start?signin=failed', 'set-cookie': clearCookie(OAUTH_COOKIE) });
      }
    }
    if (req.method === 'POST' && pathname === '/auth/logout') {
      guard(req);
      const ok = await auth.logout(sessionToken(req));
      // The session is already gone in memory, so the cookie goes either way; the 503 only says it is not durable yet.
      if (!ok) { const e = savingUnavailable(); return send(res, e.code, { error: e.message, code: e.apiCode }, { 'set-cookie': clearCookie(SESSION_COOKIE) }); }
      return send(res, 204, '', { 'set-cookie': clearCookie(SESSION_COOKIE) });
    }
    return send(res, 404, 'Not found');
  }

  // The signed-in user and the JSON body of a key route: refused before the body is read, and again after it (the session may have
  // ended meanwhile).
  async function userAndBody(req) {
    requireUser(req);
    const body = await readObject(req, BODY_LIMIT);
    return { user: requireUser(req), body };
  }

  async function handleMe(req, res, parts) {
    const route = `${req.method} /${parts.slice(2).join('/')}`;
    if (route === 'GET /') {
      const user = auth ? auth.userForSession(sessionToken(req)) : null;
      send(res, 200, {
        user: user ? { login: user.login } : null, signin: auth ? 'github' : 'off', agentKeys: user ? auth.agentKeysInfo(user) : [],
        ai: user ? aiAccess.status(user) : 'none', admin: Boolean(user) && aiAccess.isAdmin(user),
      });
      return true;
    }
    if (!auth) return false;
    switch (route) {
      case 'POST /ai-access': {
        const { user, body } = await userAndBody(req);
        const asked = aiAccess.request(user, body.note);
        if (!asked.ok) throw askRefused(asked);
        send(res, 200, { status: asked.status });
        return true;
      }
      case 'POST /agent-key': {
        const { user, body } = await userAndBody(req);
        if (!Object.prototype.hasOwnProperty.call(body, 'name')) throw new ApiError(400, 'Reload the page and try again.');
        // what is refused for the name or the count is refused before it costs any of the rate allowance
        const check = auth.checkMint(user, body.name);
        if (!check.ok) throw refused(check);
        if (!auth.userRateOk(user.id)) throw new ApiError(429, RATE_LIMITED, 'rate_limited');
        const minted = await auth.mintAgentKey(user, body.name);
        if (!minted.ok) throw refused(minted);
        send(res, 201, { key: minted.key, kid: minted.kid, name: minted.name, createdAt: minted.createdAt });
        return true;
      }
      case 'POST /agent-key/revoke': {
        const { user, body } = await userAndBody(req);
        if (typeof body.kid !== 'string' || !KID.test(body.kid)) throw new ApiError(400, 'Say which agent key to delete.');
        if (!(await auth.revokeAgentKey(user, body.kid))) throw savingUnavailable();
        send(res, 204, '');
        return true;
      }
      default:
        return false;
    }
  }

  // The owner's side of "Use our AI": GET /api/admin/ai-access (the requests) and POST /api/admin/ai-access (a decision). Always answers.
  // To anyone who is not an admin (signed out included) there is nothing here: 404, the same as a path that does not exist. The GET
  // reads the session only, like GET /api/me, because a browser sends no Origin or content type with a plain GET. The POST reads the
  // session and checks admin FIRST (404), so a non-admin never learns of the Origin and content-type rules; only then requireUser
  // (403, 415, 401), the body, and requireUser and admin again (the session may have ended meanwhile).
  async function handleAdmin(req, res, parts) {
    const notFound = () => new ApiError(404, 'Not found');
    const admin = (user) => { if (!user || !aiAccess.isAdmin(user)) throw notFound(); return user; };
    if (!auth || parts[2] !== 'ai-access' || parts.length !== 3) throw notFound();
    if (req.method === 'GET') {
      admin(auth.userForSession(sessionToken(req)));
      return send(res, 200, { requests: aiAccess.list() });
    }
    if (req.method !== 'POST') throw notFound();
    admin(auth.userForSession(sessionToken(req)));
    requireUser(req);
    const body = await readObject(req, BODY_LIMIT);
    const user = admin(requireUser(req));
    if (typeof body.userId !== 'string' || !USER_ID.test(body.userId) || !DECISIONS.includes(body.decision)) throw new ApiError(400, 'Say which request to decide, and how.');
    const done = await aiAccess.decide(body.userId, body.decision, user.id);
    if (!done.ok) throw done.reason === 'user' ? new ApiError(400, 'Say which request to decide, and how.') : savingUnavailable();
    return send(res, 204, '');
  }

  return { handleAuth, handleMe, handleAdmin, requireUser };
}

module.exports = { createAuthRoutes };
