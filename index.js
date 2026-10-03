'use strict';
// Proxy Room: reference implementation of PXP v0 (Proxy Exchange Protocol).
// Zero dependencies. Node 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pxp = require('./lib/pxp');
const mcp = require('./lib/mcp');
const { ROOT } = require('./lib/config');
const { createLog } = require('./lib/log');
const { createApp } = require('./lib/app');
const { StoreError } = require('./lib/store');
const { authSeat } = require('./lib/view');

// Set before routing, so every response gets these, including /mcp (whose handler writes its own writeHead).
// Every response carries the full policy: harmless on JSON, and it keeps one place to change.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SEC_HEADERS = { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP };
const log = createLog();
let app;
try { app = createApp({ log }); } catch (e) { log.error(e instanceof StoreError ? 'store.load_failed' : 'app.init_failed', {}, e); process.exit(1); }
const { config, domain, ops, view } = app;
const { port: PORT, bindHost: HOST, dataDir: DATA_DIR, maxTurns: MAX_TURNS, publicUrl: PUBLIC_URL } = config;
const { ApiError } = domain;
const rooms = domain.rooms;
const proxy = app.proxy;
const PUBLIC = path.join(ROOT, 'web');

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': isObj ? 'application/json' : 'text/plain', 'cache-control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new ApiError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new ApiError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}

function clientIp(req) {
  // Caddy appends the real client address last.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || req.socket.remoteAddress || 'unknown';
}

// ---------- live updates (SSE) ----------
const streams = new Map(); // roomId -> Set<{res, seat, token}>
domain.onChange((room, kind) => {
  if (kind !== 'change') return;
  const set = streams.get(room.id);
  if (!set) return;
  for (const c of set) {
    try { c.res.write(`data: ${JSON.stringify(view(room, c.seat, c.token))}\n\n`); } catch {}
  }
});

// ---------- routes ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const q = url.searchParams;

  if (req.method === 'GET' && parts[1] === 'config') {
    return send(res, 200, { live: proxy.live(), passcode: ops.passcodeRequired(), maxTurns: MAX_TURNS, protocol: 'PXP/0', mcpUrl: `${PUBLIC_URL}/mcp` });
  }

  if (req.method === 'POST' && parts[1] === 'demo' && parts.length === 2) {
    const room = domain.createDemoRoom();
    return send(res, 201, { id: room.id, token: room.seats.A.token });
  }

  if (req.method === 'POST' && parts[1] === 'rooms' && parts.length === 2) {
    const body = await readBody(req);
    const room = domain.createLiveRoom(clientIp(req), body);
    return send(res, 201, { id: room.id, links: { A: `/room/${room.id}?seat=A&t=${room.seats.A.token}`, B: `/room/${room.id}?seat=B&t=${room.seats.B.token}` }, modes: { A: room.seats.A.mode, B: room.seats.B.mode } });
  }

  const room = parts[1] === 'rooms' && rooms.get(parts[2]);
  if (!room) return send(res, 404, { error: 'Room not found' });

  if (req.method === 'GET' && parts.length === 3) return send(res, 200, view(room, q.get('seat'), q.get('t')));

  if (req.method === 'GET' && parts[3] === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const client = { res, seat: q.get('seat'), token: q.get('t') };
    if (!streams.has(room.id)) streams.set(room.id, new Set());
    streams.get(room.id).add(client);
    res.write(`data: ${JSON.stringify(view(room, client.seat, client.token))}\n\n`);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); streams.get(room.id) && streams.get(room.id).delete(client); });
    return;
  }

  if (req.method === 'GET' && parts[3] === 'ledger') {
    return send(res, 200, { protocol: 'PXP/0', room: room.id, check: pxp.verifyLedger(room.ledger), ledger: room.ledger });
  }

  // seat actions: /api/rooms/:id/seats/:seat/(draft|seal|answer|resume)
  if (req.method === 'POST' && parts[3] === 'seats') {
    const seatId = parts[4];
    if (!['A', 'B'].includes(seatId)) return send(res, 400, { error: 'Unknown seat' });
    const body = await readBody(req);
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

// Fingerprint of the deployed source, so a deploy can be checked against a local tree.
const BUILD = (() => {
  const h = crypto.createHash('sha256');
  const walk = d => fs.readdirSync(d, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && !(d === __dirname && e.name === 'docs'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(e => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else h.update(path.relative(__dirname, p) + '\0').update(fs.readFileSync(p)); });
  try { walk(__dirname); } catch {}
  return h.digest('hex').slice(0, 12);
})();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  let url;
  // A request target like "//" or "//a:b" makes new URL throw; outside the try that crashed the process.
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'Bad request'); }
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true, live: proxy.live(), rooms: rooms.size, build: BUILD });
    if (url.pathname === '/mcp') return await mcp.handle(req, res, ops, { readBody, clientIp });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/room/')) return serveFile(res, path.join(PUBLIC, 'room.html'));
    if (url.pathname.startsWith('/brief/')) return serveFile(res, path.join(PUBLIC, 'agreement.html'));
    if (url.pathname.startsWith('/spec/')) return serveFile(res, path.join(__dirname, 'spec', path.basename(url.pathname)));
    if (url.pathname === '/spec') return serveFile(res, path.join(PUBLIC, 'spec.html'));
    if (url.pathname === '/start') return serveFile(res, path.join(PUBLIC, 'start.html'));
    if (url.pathname === '/connect') return serveFile(res, path.join(PUBLIC, 'connect.html'));
    if (url.pathname === '/ui' || url.pathname === '/ui/') return serveFile(res, path.join(PUBLIC, 'ui', 'index.html'));
    const f = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!(f === PUBLIC || f.startsWith(PUBLIC + path.sep))) return send(res, 403, 'Forbidden');
    return serveFile(res, f);
  } catch (e) {
    if (!(e instanceof ApiError)) log.error('http.unexpected', {}, e);
    if (!res.headersSent) send(res, e instanceof ApiError ? e.code : 500, { error: e instanceof ApiError ? e.message : 'Server error' });
  }
});

const onListen = () => console.log(`Proxy Room (PXP/0) on :${server.address().port} · live=${proxy.live()} · model=${proxy.MODEL} · data=${DATA_DIR} · mcp=${PUBLIC_URL}/mcp`);
server.listen(PORT, HOST || undefined, onListen); // unset or empty BIND_HOST binds all interfaces
