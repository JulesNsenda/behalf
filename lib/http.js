'use strict';
// The HTTP layer: security headers, routing, the REST API, GitHub sign-in (cookies and routes), live updates (SSE), static
// files and the build fingerprint.
// createHttpServer({ root, domain, view, authSeat, log, mcpHandle, info, trustProxy, limits, auth }) returns
// { server, close, diagnostics }. It never listens and never touches the store or the turn loop: lib/app.js wires
// those and owns shutdown. `info` is { live(), passcodeRequired(), maxTurns, publicUrl, signin, signinOn, storeKind(), storeOk() } for
// /health and /api/config. `auth` (lib/auth.js) is required when info.signinOn.
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
const net = require('./net');
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
const PAGES = [['/', 'index.html'], ['/start', 'start.html'], ['/connect', 'connect.html'], ['/spec', 'spec.html'], ['/ui', 'ui/index.html'], ['/ui/', 'ui/index.html']];
const PREFIX_PAGES = [['/room/', 'room.html'], ['/brief/', 'agreement.html']];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

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

// The file under `publicDir` that a request path names, or null for anything that is not inside it. Pure. The path is
// the raw one (a URL's pathname never has dot segments, but this must hold without that). A colon is refused for
// Windows drive letters and alternate data streams, a backslash and a leading "//" for UNC and mixed-separator tricks.
function resolveStatic(publicDir, pathname) {
  if (/[:\\]/.test(pathname) || pathname.startsWith('//')) return null;
  const f = path.join(publicDir, pathname === '/' ? 'index.html' : path.normalize('.' + pathname));
  return f === publicDir || f.startsWith(publicDir + path.sep) ? f : null;
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

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

// trustProxy(req) says whether X-Forwarded-For may be believed for this request. It is required, so that a caller
// decides it on purpose.
function createHttpServer({ root = ROOT, domain, view, authSeat, log, mcpHandle, info, trustProxy, limits, auth }) {
  if (typeof trustProxy !== 'function') throw new TypeError('createHttpServer needs a trustProxy function');
  const signinOn = Boolean(info.signinOn);
  if (signinOn && !auth) throw new TypeError('createHttpServer needs auth when sign-in is on');
  const rooms = domain.rooms;
  const publicDir = path.join(root, 'web');
  const max = { ...STREAM_LIMITS, ...limits };
  let build = null; // computed on the first /health, not at load
  let closed = false;

  // The canonical address to rate-limit (lib/net.js): the last X-Forwarded-For entry from a trusted peer, else the socket's.
  const clientIp = (req) => net.clientIp(req, trustProxy);
  const authRoutes = createAuthRoutes({ auth: signinOn ? auth : null, publicUrl: info.publicUrl, log, clientIp, send });

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

  // ---------- routes ----------
  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const q = url.searchParams;

    if (req.method === 'GET' && parts[1] === 'config') {
      return send(res, 200, { live: info.live(), passcode: info.passcodeRequired(), maxTurns: info.maxTurns, protocol: 'PXP/0', mcpUrl: `${info.publicUrl}/mcp`, signin: info.signin });
    }

    if (parts[1] === 'me' && await authRoutes.handleMe(req, res, parts)) return;

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
      if (pathname === '/health') return send(res, 200, { ok: true, live: info.live(), rooms: rooms.size, store: info.storeKind(), storeOk: info.storeOk(), build: build || (build = fingerprint(root)) });
      // mcp answers an oversize body itself (413, with its CORS headers), declared or streamed alike.
      if (pathname === '/mcp') return await mcpHandle(req, res, { readBody: readJson, clientIp });
      if (signinOn && pathname.startsWith('/auth/')) return await authRoutes.handleAuth(req, res, url);
      if (pathname.startsWith('/api/')) return await api(req, res, url);
      const page = PAGES.find(([p]) => p === pathname) || PREFIX_PAGES.find(([p]) => pathname.startsWith(p));
      if (page) return serveFile(res, path.join(publicDir, page[1]));
      if (pathname.startsWith('/spec/')) return serveFile(res, path.join(root, 'spec', path.basename(pathname)));
      const f = resolveStatic(publicDir, pathname);
      if (!f) return send(res, 403, 'Forbidden');
      return serveFile(res, f);
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

module.exports = { createHttpServer, resolveStatic };
