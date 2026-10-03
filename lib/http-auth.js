'use strict';
// The sign-in part of the HTTP layer: the cookies, the guards and the routes /auth/* and /api/me*. lib/http.js dispatches to it.
// createAuthRoutes({ auth, publicUrl, log, clientIp, send }) -> { handleAuth, handleMe, requireUser }. `auth` (lib/auth.js) is null with
// sign-in off: then only GET /api/me answers (as signed out) and nothing else here exists.
//  - handleAuth(req, res, url): /auth/github, /auth/github/callback and POST /auth/logout. Always answers.
//  - handleMe(req, res, parts): /api/me, POST /api/me/agent-key and POST /api/me/agent-key/revoke, by `${method} /${sub}`. Resolves
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

const OAUTH_COOKIE = '__Host-behalf_oauth';
const SESSION_COOKIE = '__Host-behalf_session';
const OAUTH_MAX_AGE = 600;
const SESSION_MAX_AGE = 30 * 24 * 3600;
const RATE_LIMITED = 'Too many requests. Try again in a few minutes.';

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

function createAuthRoutes({ auth, publicUrl, log, clientIp, send }) {
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

  async function handleMe(req, res, parts) {
    const route = `${req.method} /${parts.slice(2).join('/')}`;
    if (route === 'GET /') {
      const user = auth ? auth.userForSession(sessionToken(req)) : null;
      send(res, 200, { user: user ? { login: user.login } : null, signin: auth ? 'github' : 'off', agentKey: user ? auth.agentKeyInfo(user) : null });
      return true;
    }
    if (!auth) return false;
    switch (route) {
      case 'POST /agent-key': {
        const user = requireUser(req);
        if (!auth.userRateOk(user.id)) throw new ApiError(429, RATE_LIMITED, 'rate_limited');
        const minted = await auth.mintAgentKey(user);
        if (!minted) throw savingUnavailable();
        send(res, 201, minted);
        return true;
      }
      case 'POST /agent-key/revoke':
        if (!(await auth.revokeAgentKey(requireUser(req)))) throw savingUnavailable();
        send(res, 204, '');
        return true;
      default:
        return false;
    }
  }

  return { handleAuth, handleMe, requireUser };
}

module.exports = { createAuthRoutes };
