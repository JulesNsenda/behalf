'use strict';
// The HTTP layer: security headers, routing, the REST API, GitHub sign-in (cookies and routes), live updates (SSE), static
// files (routing only: lib/static.js serves them; staticNow is its clock, for tests) and the build fingerprint.
// createHttpServer({ root, domain, view, authSeat, log, mcpHandle, info, trustProxy, limits, auth, aiAccess, notices, invite, outbox, staticNow }) returns
// { server, close, diagnostics }. It never listens and never touches the store or the turn loop: lib/app.js wires
// those and owns shutdown. `info` is { live(), passcodeRequired(), maxTurns, publicUrl, signin, signinOn, storeKind(), storeOk(),
// mailKind, mailOk() } for /health and /api/config. `outbox` is the dev mail outbox ({ list(), read(id) }) for /dev/outbox, or null:
// lib/app.js passes it only off the platform. `auth` (lib/auth.js) is required when info.signinOn, and so is `aiAccess`
// (lib/ai-access.js: GET /api/me's ai and admin, POST /api/me/ai-access, /api/admin/ai-access), and `notices` and `invite`
// (lib/notices.js deliverable: /api/config's invite; lib/app.js invite({ room, seatId, user, to }): the one composed operation behind
// POST .../seats/A/invite, which checks the mail, reserves the slots and queues the email in one synchronous run).
// Sign-in (lib/http-auth.js: cookies, guards, /auth/* and /api/me*) exists only when info.signinOn (otherwise those paths
// are unknown routes, except GET /api/me, which answers signed out). This file dispatches to it and calls its requireUser for
// POST /api/rooms. The rules for the cookies, the Origin and content-type guards, durability and rates are written there.
// diagnostics = { streamCount(roomId), streamRooms(), clientIp(req) } exists for tests and debugging only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pxp = require('./pxp');
const { ROOT } = require('./config');
const { ApiError } = require('./errors');
const { isEmail } = require('./mail');
const net = require('./net');
const { createStaticFiles, serveFile, resolveStatic } = require('./static');
const { createAuthRoutes } = require('./http-auth');

// Set before routing, so every response gets these, including /mcp (whose handler writes its own writeHead).
// Every response carries the full policy: harmless on JSON, and it keeps one place to change.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SEC_HEADERS = { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP };

// Live-update (SSE) connections: per room, anonymous viewers and each authenticated seat have their own bucket. The
// global ceilings leave headroom for seats: anonymous streams, and every stream of a demo room, stop at globalAnon; all streams stop at global.
const STREAM_LIMITS = { anon: 20, seat: 5, globalAnon: 800, global: 1200 };
const REST_BODY_LIMIT = 64 * 1024;

// Static routes: exact paths, then path prefixes, each mapped to a file under web/. Anything else falls through to
// resolveStatic.
const PAGES = [['/', 'index.html'], ['/start', 'start.html'], ['/connect', 'connect.html'], ['/admin', 'admin.html'], ['/spec', 'spec.html'], ['/ui', 'ui/index.html'], ['/ui/', 'ui/index.html']];
const PREFIX_PAGES = [['/room/', 'room.html'], ['/brief/', 'agreement.html']];

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': isObj ? 'application/json' : 'text/plain', 'cache-control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

// Any JSON value (an empty body is {}). /mcp uses it directly, because a JSON-RPC batch is an array.
// An oversize body is refused as soon as it is known (declared, or once the limit is passed): nothing more is
// buffered, and the rest is read and thrown away so the 413 can be sent.
function readJson(req, limit = REST_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const refuse = () => { req.resume(); reject(new ApiError(413, 'Body too large')); };
    if (Number(req.headers['content-length']) > limit) return refuse();
    let size = 0; const chunks = [];
    const onData = c => {
      size += c.length;
      if (size <= limit) { chunks.push(c); return; }
      req.removeListener('data', onData);
      refuse();
    };
    req.on('data', onData);
    req.on('end', () => {
      if (size > limit) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch { reject(new ApiError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// The REST body must be a JSON object.
async function readObject(req, limit) {
  const body = await readJson(req, limit);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Invalid JSON');
  return body;
}

// Fingerprint of the deployed source, so a deploy can be checked against a local tree. Dot files, node_modules and
// the top-level docs/ are left out.
function fingerprint(root) {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && !(dir === root && e.name === 'docs'))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      h.update(path.relative(root, p) + '\0').update(fs.readFileSync(p));
    }
  };
  try { walk(root); } catch {}
  return h.digest('hex').slice(0, 12);
}

// trustProxy(req) says whether X-Forwarded-For may be believed for this request. It is required, so that a caller
// decides it on purpose.
function createHttpServer({ root = ROOT, domain, view, authSeat, log, mcpHandle, info, trustProxy, limits, auth, aiAccess = null, notices = null, invite = null, outbox = null, staticNow }) {
  if (typeof trustProxy !== 'function') throw new TypeError('createHttpServer needs a trustProxy function');
  const signinOn = Boolean(info.signinOn);
  if (signinOn && !auth) throw new TypeError('createHttpServer needs auth when sign-in is on');
  if (signinOn && !aiAccess) throw new TypeError('createHttpServer needs aiAccess when sign-in is on');
  if (signinOn && !(notices && invite)) throw new TypeError('createHttpServer needs notices and invite when sign-in is on');
  const rooms = domain.rooms;
  const publicDir = path.join(root, 'web');
  const staticFiles = createStaticFiles(publicDir, { now: staticNow });
  const max = { ...STREAM_LIMITS, ...limits };
  let build = null; // computed on the first /health, not at load
  let closed = false;

  // The canonical address to rate-limit (lib/net.js): the last X-Forwarded-For entry from a trusted peer, else the socket's.
  const clientIp = (req) => net.clientIp(req, trustProxy);
  const authRoutes = createAuthRoutes({ auth: signinOn ? auth : null, aiAccess: signinOn ? aiAccess : null, publicUrl: info.publicUrl, log, clientIp, send, readObject });

  // ---------- live updates (SSE) ----------
  // roomId -> Set<{res, seat, token, bucket, ping}>, in connection order. The bucket is the seat id only when the token
  // proves it, else 'anon'. A newcomer is refused with 204 when its anonymous bucket or a global ceiling is full: 204
  // refuses the stream, and the room page's own retry loop backs off and tries again later. An open anonymous stream
  // is never evicted. A seat holder whose bucket is full replaces that seat's oldest stream (a half-open one from a
  // phone that went away). An empty set is deleted.
  const streams = new Map();
  let total = 0;
  let anonTotal = 0;

  function drop(roomId, client) {
    clearInterval(client.ping);
    const set = streams.get(roomId);
    if (!set || !set.delete(client)) return;
    total--;
    if (client.free) anonTotal--;
    if (!set.size) streams.delete(roomId);
  }

  // Ends one stream; the room's other streams are not affected.
  function end(roomId, client) {
    drop(roomId, client);
    try { client.res.end(); } catch {}
  }

  // Ends every stream of a room (it was evicted, or the server is closing).
  function closeRoom(roomId) {
    for (const c of [...(streams.get(roomId) || [])]) end(roomId, c);
  }

  const countBucket = (set, bucket) => (set ? [...set].filter(c => c.bucket === bucket).length : 0);

  const unsubscribe = domain.onChange((room, kind) => {
    if (kind === 'evicted') return closeRoom(room.id);
    if (kind !== 'change') return;
    const set = streams.get(room.id);
    if (!set) return;
    for (const c of set) {
      try { c.res.write(`data: ${JSON.stringify(view(room, c.seat, c.token))}\n\n`); } catch {}
    }
  });

  function subscribe(req, res, room, q) {
    const seat = q.get('seat'); const token = q.get('t');
    const bucket = authSeat(room, seat, token) ? seat : 'anon';
    const anon = bucket === 'anon';
    // A demo room's seat token is free for anyone, so its streams count against the anonymous ceiling too.
    const free = anon || room.demo === true;
    const set = streams.get(room.id);
    const full = countBucket(set, bucket) >= (anon ? max.anon : max.seat);
    if (full && !anon) end(room.id, [...set].find(c => c.bucket === bucket));
    if (total >= max.global || (free && anonTotal >= max.globalAnon) || (anon && full)) {
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const client = { res, seat, token, bucket, free, ping: null };
    if (!streams.has(room.id)) streams.set(room.id, new Set());
    streams.get(room.id).add(client);
    total++;
    if (free) anonTotal++;
    // The cleanup is registered before anything that can throw (the first view), so a failure cannot leak the subscriber.
    client.ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => drop(room.id, client));
    try { res.write(`data: ${JSON.stringify(view(room, seat, token))}\n\n`); } catch (e) {
      log.error('http.unexpected', {}, e);
      end(room.id, client);
    }
  }

  // ---------- the dev outbox ----------
  // /dev/outbox lists what the dev mail transport wrote; /dev/outbox/<id> shows one email as the recipient would see it, and
  // /dev/outbox/<id>.json its envelope. Without an outbox (smtp, or on the platform) every path is a 404. An email's HTML carries
  // its own inline styles, so its page gets a policy of its own: inline styles and images, no script, sandboxed.
  const EMAIL_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  function devOutbox(req, res, pathname) {
    if (!outbox || req.method !== 'GET') return send(res, 404, 'Not found');
    const rest = pathname.slice('/dev/outbox'.length).replace(/^\//, '');
    if (!rest) return send(res, 200, outboxPage(outbox.list()), { 'content-type': 'text/html; charset=utf-8' });
    const json = rest.endsWith('.json');
    const found = outbox.read(json ? rest.slice(0, -5) : rest);
    if (!found) return send(res, 404, 'Not found');
    if (json) return send(res, 200, found.record);
    return send(res, 200, found.html, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': EMAIL_CSP });
  }

  // ---------- routes ----------
  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const q = url.searchParams;

    if (req.method === 'GET' && parts[1] === 'config') {
      return send(res, 200, { live: info.live(), passcode: info.passcodeRequired(), maxTurns: info.maxTurns, protocol: 'PXP/0', mcpUrl: `${info.publicUrl}/mcp`, signin: info.signin, invite: signinOn && Boolean(notices && notices.deliverable()) });
    }

    if (parts[1] === 'me' && await authRoutes.handleMe(req, res, parts)) return;

    // The admin routes answer for themselves (404 to anyone who is not an admin). With sign-in off they do not exist: normal routing.
    if (signinOn && parts[1] === 'admin') return await authRoutes.handleAdmin(req, res, parts);

    if (req.method === 'POST' && parts[1] === 'demo' && parts.length === 2) {
      const room = domain.createDemoRoom();
      return send(res, 201, { id: room.id, token: room.seats.A.token });
    }

    if (req.method === 'POST' && parts[1] === 'rooms' && parts.length === 2) {
      if (signinOn) authRoutes.requireUser(req); // before the body is read
      const body = await readObject(req);
      // The session is read again once the body is in: one that was logged out, expired or blocked while it was coming is not honoured.
      const user = signinOn ? authRoutes.requireUser(req) : undefined;
      const room = domain.createLiveRoom(clientIp(req), body, user);
      return send(res, 201, { id: room.id, links: { A: `/room/${room.id}?seat=A&t=${room.seats.A.token}`, B: `/room/${room.id}?seat=B&t=${room.seats.B.token}` }, modes: { A: room.seats.A.mode, B: room.seats.B.mode } });
    }

    // POST /api/rooms/:id/seats/A/invite { token, email }: emails the seat B link. It is matched before the shared seat block because
    // it needs a signed-in owner as well as the seat token, and its own order of refusals; the body is small (4096), as for the key
    // routes. Everything after the shape checks is one call to invite() (lib/app.js), which is synchronous, so parallel posts cannot go
    // past a limit. The address is only held here, and goes to the mailer: it is never stored or logged, and the answer (202) does not
    // depend on whether a mailbox exists.
    if (req.method === 'POST' && parts[1] === 'rooms' && parts[3] === 'seats' && parts[5] === 'invite' && parts.length === 6) {
      if (!signinOn || parts[4] !== 'A') return send(res, 404, { error: 'Not found' });
      const { user, body } = await authRoutes.userAndBody(req);
      const invited = rooms.get(parts[2]);
      if (!invited) return send(res, 404, { error: 'Room not found' }); // unknown, or evicted while the body was arriving
      if (typeof body.token !== 'string' || !body.token) return send(res, 400, { error: 'Missing or bad seat token' });
      if (!authSeat(invited, 'A', body.token)) return send(res, 403, { error: 'This link does not control that seat.' });
      const to = typeof body.email === 'string' ? body.email.trim() : '';
      if (!isEmail(to)) return send(res, 400, { error: 'That email address does not look right.' });
      invite({ room: invited, seatId: 'A', user, to });
      return send(res, 202, { status: 'queued' });
    }

    const room = parts[1] === 'rooms' && rooms.get(parts[2]);
    if (!room) return send(res, 404, { error: 'Room not found' });

    if (req.method === 'GET' && parts.length === 3) return send(res, 200, view(room, q.get('seat'), q.get('t')));

    if (req.method === 'GET' && parts[3] === 'events') return subscribe(req, res, room, q);

    if (req.method === 'GET' && parts[3] === 'ledger') {
      return send(res, 200, { protocol: 'PXP/0', room: room.id, check: pxp.verifyLedger(room.ledger), ledger: room.ledger });
    }

    // seat actions: /api/rooms/:id/seats/:seat/(draft|seal|answer|resume)
    if (req.method === 'POST' && parts[3] === 'seats') {
      const seatId = parts[4];
      if (!['A', 'B'].includes(seatId)) return send(res, 400, { error: 'Unknown seat' });
      const body = await readObject(req);
      // The room may have been evicted while the body was arriving.
      if (rooms.get(parts[2]) !== room) return send(res, 404, { error: 'Room not found' });
      const seat = authSeat(room, seatId, body.token);
      if (!seat) return send(res, 403, { error: 'This link does not control that seat.' });
      const action = parts[5];

      if (action === 'draft') {
        const card = await domain.draftCard(room, seatId, body);
        return send(res, 200, { card });
      }

      if (action === 'seal') {
        domain.sealCard(room, seatId, room.demo ? seat.card : body.card, 'web');
        return send(res, 200, { ok: true, card_hash: seat.cardHash });
      }

      if (action === 'answer') {
        if (room.demo) domain.answerDemo(room, seatId, body.option);
        else domain.answerEscalation(room, seatId, body.answer, 'web');
        return send(res, 200, { ok: true });
      }

      if (action === 'resume') { domain.resume(room); return send(res, 200, { ok: true }); }
    }

    return send(res, 404, { error: 'Not found' });
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
    let url;
    // A request target like "//" or "//a:b" makes new URL throw; outside the try that crashed the process.
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'Bad request'); }
    const pathname = url.pathname;
    try {
      if (pathname === '/health') {
        return send(res, 200, {
          ok: true, live: info.live(), rooms: rooms.size, store: info.storeKind(), storeOk: info.storeOk(),
          mail: info.mailKind || 'dev', mailOk: info.mailOk ? info.mailOk() : false, build: build || (build = fingerprint(root)),
        });
      }
      if (pathname === '/dev/outbox' || pathname.startsWith('/dev/outbox/')) return devOutbox(req, res, pathname);
      // mcp answers an oversize body itself (413, with its CORS headers), declared or streamed alike.
      if (pathname === '/mcp') return await mcpHandle(req, res, { readBody: readJson, clientIp });
      // /key is a short link an agent can be told: with sign-in on it lands on the key panel (a fixed target, nothing from the request).
      // Anything else (sign-in off, another method) falls through to the 404 any unknown path gets.
      if (pathname === '/key' && signinOn && (req.method === 'GET' || req.method === 'HEAD')) return send(res, 302, '', { location: '/connect#agent-keys' });
      if (signinOn && pathname.startsWith('/auth/')) return await authRoutes.handleAuth(req, res, url);
      if (pathname.startsWith('/api/')) return await api(req, res, url);
      const page = PAGES.find(([p]) => p === pathname) || PREFIX_PAGES.find(([p]) => pathname.startsWith(p));
      if (page) return serveFile(res, req, path.join(publicDir, page[1]), staticFiles);
      if (pathname.startsWith('/spec/')) return serveFile(res, req, path.join(root, 'spec', path.basename(pathname)), staticFiles);
      const f = resolveStatic(publicDir, pathname);
      if (!f) return send(res, 403, 'Forbidden');
      return serveFile(res, req, f, staticFiles, url.searchParams.get('v'));
    } catch (e) {
      if (!(e instanceof ApiError)) { log.error('http.unexpected', {}, e); e = new ApiError(500, 'Server error'); }
      if (res.headersSent) return;
      if (e.code === 413) {
        // The rest of the body was discarded; the connection ends once the answer has been sent.
        res.once('finish', () => req.socket.destroySoon()); // defence in depth: connection: close already ends it
        return send(res, 413, { error: e.message }, { connection: 'close' });
      }
      send(res, e.code, e.apiCode ? { error: e.message, code: e.apiCode } : { error: e.message });
    }
  });
  // These bound how long a client may take to send a request; an open SSE response is not affected.
  server.requestTimeout = 30000;
  server.headersTimeout = 20000;

  // Idempotent: stop hearing about rooms, end every live stream and stop accepting connections (without waiting for
  // the open ones).
  function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    for (const id of [...streams.keys()]) closeRoom(id);
    server.close();
  }

  const diagnostics = { streamCount: (roomId) => streams.get(roomId)?.size ?? 0, streamRooms: () => [...streams.keys()], clientIp };

  return { server, close, diagnostics };
}

// The outbox list, built here from escaped values only.
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const who = (a) => (a && typeof a === 'object' ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');
function outboxPage(items) {
  const rows = items.map((m) => `<li class="stack stack--sm"><a href="/dev/outbox/${esc(m.id)}">${esc(m.subject)}</a>`
    + `<span class="text-caption">${esc(m.at)} · to ${esc(who(m.to))} · from ${esc(who(m.from))}${m.replyTo ? ` · reply to ${esc(m.replyTo)}` : ''}`
    + ` · <a href="/dev/outbox/${esc(m.id)}.json">json</a></span></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>Dev outbox · Behalf</title><link rel="stylesheet" href="/ui/ui.css"></head>`
    + `<body><main class="container stack stack--md"><h1>Dev outbox</h1><p class="text-muted">Emails the dev mail transport wrote, newest first. Nothing here was sent.</p>`
    + (rows ? `<ul class="stack stack--sm">${rows}</ul>` : '<p>No emails yet.</p>') + '</main></body></html>';
}

module.exports = { createHttpServer, resolveStatic };
