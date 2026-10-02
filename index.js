'use strict';
// Proxy Room: reference implementation of PXP v0 (Proxy Exchange Protocol).
// Zero dependencies. Node 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pxp = require('./lib/pxp');
const proxy = require('./lib/proxy');
const demo = require('./lib/demo');
const mcp = require('./lib/mcp');
const { parsePort } = require('./lib/port');

const PORT = parsePort(process.env.PORT);
const HOST = process.env.BIND_HOST; // not HOST: csh-style shells export that as the machine name
// Set before routing, so every response gets these, including /mcp (whose handler writes its own writeHead).
const SEC_HEADERS = { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'none'" };
const DATA_DIR = process.env.DROP_DATA_DIR || path.join(__dirname, '.data');
const STORE = path.join(DATA_DIR, 'rooms.json');
const PUBLIC = path.join(__dirname, 'web');
const DAILY_ROOM_LIMIT = Number(process.env.DAILY_ROOM_LIMIT) || 20;
const PER_IP_DAILY = Number(process.env.PER_IP_DAILY) || 3;
const PASSCODE = process.env.ROOM_PASSCODE || '';
const MAX_TURNS = Number(process.env.MAX_TURNS) || 10;
const DEMO_DELAY = Number(process.env.DEMO_DELAY_MS) || 2600;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://proxy-room.dropkit.sh').replace(/\/$/, '');

// ---------- persistence ----------
let rooms = new Map();
let usage = { day: '', total: 0, byIp: {} };
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STORE)) {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    rooms = new Map(Object.entries(raw.rooms || {}));
    usage = raw.usage || usage;
    for (const r of rooms.values()) {
      r.running = false; r.thinking = null;
      for (const s of ['A', 'B']) if (!r.seats[s].mode) r.seats[s].mode = 'builtin';
      // A built-in turn in flight is lost on restart; an external seat is simply still waiting.
      if (r.status === 'negotiating' && !r.waitingOn) { r.status = 'paused'; r.interrupted = true; }
    }
  }
} catch (e) { console.error('[store] load failed:', e.message); }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = STORE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ rooms: Object.fromEntries(rooms), usage }, (k, v) => (k === 'running' ? undefined : v)));
      fs.renameSync(tmp, STORE);
    } catch (e) { console.error('[store] save failed:', e.message); }
  }, 300);
}

// ---------- helpers ----------
const id = (n = 8) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n + 2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const other = s => (s === 'A' ? 'B' : 'A');

class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

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

function authSeat(room, seatId, token) {
  const s = room && room.seats && room.seats[seatId];
  if (!s || !token) return null;
  const a = Buffer.from(String(token).padEnd(64).slice(0, 64));
  const b = Buffer.from(s.token.padEnd(64).slice(0, 64));
  return crypto.timingSafeEqual(a, b) ? s : null;
}

function newSeat() {
  return { token: id(16), name: '', card: null, cardHash: null, sealed: false, draftText: '', mode: 'builtin', agent: null };
}

const seatLink = (room, s) => `${PUBLIC_URL}/room/${room.id}?seat=${s}&t=${room.seats[s].token}`;

// ---------- public view (never leaks the other side's card or tokens) ----------
function view(room, seatId, token) {
  const mine = seatId && authSeat(room, seatId, token) ? seatId : null;
  const seats = {};
  for (const s of ['A', 'B']) {
    const st = room.seats[s];
    seats[s] = {
      name: (st.card && st.card.principal.name) || st.name || `Seat ${s}`,
      role: st.card ? st.card.principal.role : '',
      sealed: st.sealed, cardHash: st.cardHash, drafted: Boolean(st.card),
      mode: st.mode || 'builtin', agent: st.agent || null, sealedVia: st.sealedVia || null,
    };
    if (mine === s || (room.demo && mine)) { seats[s].card = st.card; seats[s].draftText = st.draftText; }
  }
  return {
    id: room.id, topic: room.topic, demo: room.demo, status: room.status, createdAt: room.createdAt,
    seat: mine, seats, envelopes: room.envelopes, claims: Object.values(room.claims),
    turn: room.turn, turnCount: room.turnCount, maxTurns: room.maxTurns,
    pending: room.pending, error: room.error, brief: room.brief, interrupted: room.interrupted || false,
    ledger: room.ledger.map(e => ({ n: e.n, type: e.type, at: e.at, hash: e.hash, prev: e.prev, data: e.data })),
    ledgerCheck: pxp.verifyLedger(room.ledger),
    thinking: room.thinking || null, waitingOn: room.waitingOn || null,
    live: proxy.live(), mcpUrl: `${PUBLIC_URL}/mcp`,
  };
}

// ---------- live updates (SSE) ----------
const streams = new Map(); // roomId -> Set<{res, seat, token}>
function emit(room) {
  room.version = (room.version || 0) + 1;
  save();
  const set = streams.get(room.id);
  if (!set) return;
  for (const c of set) {
    try { c.res.write(`data: ${JSON.stringify(view(room, c.seat, c.token))}\n\n`); } catch {}
  }
}

// ---------- room lifecycle ----------
function createRoom({ topic, demoMode }) {
  const room = {
    id: id(8), topic: pxp.str(topic, 160) || 'Untitled room', demo: Boolean(demoMode),
    createdAt: new Date().toISOString(), status: 'drafting',
    seats: { A: newSeat(), B: newSeat() }, envelopes: [], claims: {}, ledger: [],
    turn: 'A', turnCount: 0, maxTurns: MAX_TURNS, pending: null, brief: null, error: null, waitingOn: null,
  };
  if (room.demo) room.seats.B.token = room.seats.A.token; // one person drives both seats in the demo
  pxp.appendLedger(room, 'room_opened', { topic: room.topic, protocol: 'PXP/0' });
  rooms.set(room.id, room);
  save();
  return room;
}

function takeQuota(ip) {
  if (usage.day !== today()) usage = { day: today(), total: 0, byIp: {} };
  if (usage.total >= DAILY_ROOM_LIMIT) return 'Daily room limit reached. Try again tomorrow, or run the demo.';
  if ((usage.byIp[ip] || 0) >= PER_IP_DAILY) return 'You have opened the maximum live rooms for today. The demo is unlimited.';
  usage.total++; usage.byIp[ip] = (usage.byIp[ip] || 0) + 1;
  save();
  return null;
}

function createLiveRoom(ip, { topic, nameA, nameB, modeA, modeB, passcode }) {
  const modes = { A: modeA === 'external' ? 'external' : 'builtin', B: modeB === 'external' ? 'external' : 'builtin' };
  if (!proxy.live() && (modes.A === 'builtin' || modes.B === 'builtin')) {
    throw new ApiError(503, "Built-in Claude proxies aren't enabled on this server yet. Choose \"Bring your own agent\" for both seats.");
  }
  if (PASSCODE && passcode !== PASSCODE) throw new ApiError(403, 'Wrong or missing passcode.');
  const err = takeQuota(ip);
  if (err) throw new ApiError(429, err);
  const room = createRoom({ topic });
  room.seats.A.name = pxp.str(nameA, 80);
  room.seats.B.name = pxp.str(nameB, 80);
  room.seats.A.mode = modes.A;
  room.seats.B.mode = modes.B;
  save();
  return room;
}

function sealCard(room, seatId, cardInput, via) {
  const seat = room.seats[seatId];
  if (seat.sealed) throw new ApiError(409, 'Card already sealed.');
  const card = pxp.normaliseCard(cardInput, seat.name);
  const errs = pxp.validateCard(card);
  if (errs.length) throw new ApiError(400, errs.join('; '));
  seat.card = card;
  seat.cardHash = pxp.hashOf(card);
  seat.sealed = true;
  seat.sealedVia = via;
  pxp.appendLedger(room, 'card_sealed', { seat: seatId, principal: card.principal.name, card_hash: seat.cardHash, via });
  emit(room);
  startIfReady(room);
}

function joinAsAgent(room, seatId, agentName) {
  const seat = room.seats[seatId];
  if (room.demo) throw new ApiError(400, 'Demo rooms run scripted proxies. Create a live room to connect your own agent.');
  if (seat.mode !== 'external') {
    if (room.status !== 'drafting') throw new ApiError(409, "This seat already has a built-in proxy negotiating. An agent can only take over a seat before negotiation starts.");
    seat.mode = 'external';
  }
  const name = pxp.str(agentName, 60) || 'External agent';
  if (seat.agent !== name) {
    seat.agent = name;
    pxp.appendLedger(room, 'agent_joined', { seat: seatId, agent: name });
    emit(room);
  }
}

function answerEscalation(room, seatId, answer, via) {
  if (!room.pending || room.pending.seat !== seatId) throw new ApiError(409, 'No question is waiting for this seat.');
  answer = pxp.str(answer, 1000);
  if (!answer) throw new ApiError(400, 'Write an answer for your proxy.');
  const env = room.envelopes.find(e => e.seq === room.pending.seq);
  if (env) { env.answer = answer; env.answer_via = via; }
  const seat = room.seats[seatId];
  seat.card.amendments.push({ question: room.pending.question, answer, at: new Date().toISOString() });
  seat.cardHash = pxp.hashOf(seat.card);
  pxp.appendLedger(room, 'principal_answer', { seat: seatId, speaker: 'principal', via, answer_hash: pxp.sha256(answer), card_hash: seat.cardHash });
  room.pending = null;
  room.turn = seatId; // the proxy that escalated resumes
  run(room);
}

async function finalise(room, acceptEnv) {
  const accepted = room.envelopes.find(e => e.seq === acceptEnv.accepts.seq);
  const terms = accepted.proposal.terms;
  const dependsOn = accepted.proposal.depends_on.map(cid => room.claims[cid]).filter(Boolean);
  const unverifiedDeps = dependsOn.filter(c => !c.verified);
  let authority = null;
  try {
    if (room.demo) authority = terms.map((t, i) => ({ term: t, ...(demo.authority[room.branch] || [])[i] }));
    else if (proxy.live()) authority = await proxy.mapAuthority(room, terms);
  } catch (e) { console.error('[brief] authority mapping failed:', e.message); }

  const agreement = { terms, proposal_hash: accepted.proposal_hash, proposed_by: accepted.from.seat, proposed_seq: accepted.seq, accepted_by: acceptEnv.from.seat, accepted_seq: acceptEnv.seq };
  pxp.appendLedger(room, 'agreement', { proposal_hash: agreement.proposal_hash, proposed_by: agreement.proposed_by, accepted_by: agreement.accepted_by });
  room.brief = buildBrief(room, { agreement, authority, dependsOn, unverifiedDeps });
  room.status = 'agreed';
}

function buildBrief(room, { agreement, authority, dependsOn, unverifiedDeps }) {
  const escalations = room.envelopes.filter(e => e.escalation).map(e => ({
    seat: e.from.seat, principal: e.from.principal, question: e.escalation.question, answer: e.answer || null, via: e.answer_via || null,
  }));
  const allUnverified = Object.values(room.claims).filter(c => !c.verified);
  const challenged = Object.values(room.claims).filter(c => c.reviews.some(r => r.verdict !== 'accept'));
  const flags = room.envelopes.flatMap(e => (e.protocol_flags || []).map(f => ({ seq: e.seq, seat: e.from.seat, flag: f })));
  const check = pxp.verifyLedger(room.ledger);
  const party = s => ({ name: room.seats[s].card.principal.name, card_hash: room.seats[s].cardHash, proxy: room.seats[s].mode === 'external' ? (room.seats[s].agent || 'External agent') : 'Built-in Claude proxy' });
  return {
    outcome: agreement ? 'agreed' : 'no_agreement',
    agreement, authority,
    depends_on: dependsOn || [],
    unverified_dependencies: unverifiedDeps || [],
    unverified_in_record: allUnverified,
    challenged,
    escalations, protocol_flags: flags,
    parties: { A: party('A'), B: party('B') },
    turns: room.envelopes.length,
    ledger_head: check.head, ledger_ok: check.ok,
    generated_at: new Date().toISOString(),
  };
}

// Apply one proxy turn (from either kind of proxy) through protocol enforcement.
async function advance(room, seatId, raw) {
  const env = pxp.buildEnvelope(room, seatId, raw);
  if (room.seats[seatId].mode === 'external') env.from.agent = room.seats[seatId].agent || 'External agent';
  pxp.applyEnvelope(room, env);
  room.turnCount++;
  room.thinking = null;
  room.waitingOn = null;

  if (env.status === 'escalate') {
    room.pending = {
      seat: seatId, seq: env.seq, question: env.escalation.question, reason: env.escalation.reason,
      options: room.demo ? demo.options : null,
    };
    room.status = 'paused';
    pxp.appendLedger(room, 'escalation', { seat: seatId, seq: env.seq, question_hash: pxp.sha256(env.escalation.question) });
  } else if (env.status === 'agree') {
    await finalise(room, env);
  } else {
    room.turn = other(seatId);
  }
  emit(room);
  return env;
}

// Drive the room until agreement, escalation, the turn cap, an error,
// or a turn that belongs to an external agent (which then calls in).
async function run(room) {
  if (room.running) return;
  room.running = true;
  room.status = 'negotiating';
  room.interrupted = false;
  room.error = null;
  try {
    while (room.status === 'negotiating') {
      if (room.turnCount >= room.maxTurns) {
        room.status = 'stalled';
        room.waitingOn = null;
        pxp.appendLedger(room, 'turn_limit', { turns: room.turnCount });
        room.brief = buildBrief(room, {});
        break;
      }
      const seatId = room.turn;
      if (room.seats[seatId].mode === 'external') {
        room.waitingOn = seatId;
        room.thinking = null;
        break;
      }
      room.thinking = seatId;
      emit(room);
      let raw;
      if (room.demo) {
        await sleep(DEMO_DELAY);
        const step = room.script.shift();
        if (!step) { room.status = 'stalled'; room.brief = buildBrief(room, {}); break; }
        raw = step.raw;
      } else {
        raw = await proxy.takeTurn(room, seatId);
      }
      await advance(room, seatId, raw);
    }
  } catch (e) {
    console.error(`[room ${room.id}]`, e.message);
    room.status = 'error';
    room.error = e.message;
  } finally {
    room.running = false;
    room.thinking = null;
    emit(room);
  }
}

async function externalTurn(room, seatId, raw) {
  if (room.status !== 'negotiating' || room.waitingOn !== seatId || room.running) {
    throw new ApiError(409, room.pending ? 'The room is paused for a human answer.' : "It isn't your turn. Call wait_for_turn.");
  }
  room.running = true;
  let env;
  try { env = await advance(room, seatId, raw); }
  finally { room.running = false; }
  if (room.status === 'negotiating') run(room);
  return env;
}

function startIfReady(room) {
  if (room.seats.A.sealed && room.seats.B.sealed && room.status === 'drafting') {
    if (room.demo) room.script = demo.opening.slice();
    run(room);
  }
}

function resume(room) {
  if (!['error', 'paused'].includes(room.status) || room.pending) throw new ApiError(409, 'Nothing to resume.');
  run(room);
}

// Shared operations, used by the web API and the MCP endpoint alike.
const ops = {
  rooms, PUBLIC_URL, MAX_TURNS, ApiError, other, view, seatLink,
  authSeat, createLiveRoom, sealCard, joinAsAgent, answerEscalation, externalTurn, resume,
  live: () => proxy.live(), passcodeRequired: () => Boolean(PASSCODE),
};

// ---------- routes ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const q = url.searchParams;

  if (req.method === 'GET' && parts[1] === 'config') {
    return send(res, 200, { live: proxy.live(), passcode: Boolean(PASSCODE), maxTurns: MAX_TURNS, protocol: 'PXP/0', mcpUrl: `${PUBLIC_URL}/mcp` });
  }

  if (req.method === 'POST' && parts[1] === 'demo' && parts.length === 2) {
    const room = createRoom({ topic: demo.topic, demoMode: true });
    for (const s of ['A', 'B']) room.seats[s].card = pxp.normaliseCard(demo.cards[s]);
    save();
    return send(res, 201, { id: room.id, token: room.seats.A.token });
  }

  if (req.method === 'POST' && parts[1] === 'rooms' && parts.length === 2) {
    const body = await readBody(req);
    const room = createLiveRoom(clientIp(req), body);
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
      if (seat.sealed) return send(res, 409, { error: 'Card already sealed.' });
      if (room.demo) return send(res, 400, { error: 'Demo cards are pre-filled.' });
      if (!proxy.live()) return send(res, 503, { error: 'Drafting with Claude is not enabled on this server. Fill in the card yourself.' });
      const text = pxp.str(body.text, 4000);
      const name = pxp.str(body.name, 80) || seat.name;
      if (!text || !name) return send(res, 400, { error: 'Add your name and a brief.' });
      seat.name = name; seat.draftText = text;
      seat.drafts = (seat.drafts || 0) + 1;
      if (seat.drafts > 5) return send(res, 429, { error: 'Draft limit reached for this seat. Edit the card directly.' });
      try {
        const out = await proxy.draftCard({ name, role: pxp.str(body.role, 120), topic: room.topic, text });
        out.principal = { ...(out.principal || {}), name };
        seat.card = pxp.normaliseCard(out, name);
      } catch (e) { return send(res, 502, { error: 'Could not draft the card: ' + e.message }); }
      emit(room);
      return send(res, 200, { card: seat.card });
    }

    if (action === 'seal') {
      sealCard(room, seatId, room.demo ? seat.card : body.card, 'web');
      return send(res, 200, { ok: true, card_hash: seat.cardHash });
    }

    if (action === 'answer') {
      if (room.demo) {
        if (!room.pending || room.pending.seat !== seatId) return send(res, 409, { error: 'No question is waiting for this seat.' });
        const key = Object.prototype.hasOwnProperty.call(demo.choices, body.option) ? body.option : 'dedupe';
        room.branch = key;
        room.script = demo.branches[key].slice();
        answerEscalation(room, seatId, demo.answers[key], 'web');
      } else {
        answerEscalation(room, seatId, body.answer, 'web');
      }
      return send(res, 200, { ok: true });
    }

    if (action === 'resume') { resume(room); return send(res, 200, { ok: true }); }
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
    if (url.pathname.startsWith('/brief/')) return serveFile(res, path.join(PUBLIC, 'brief.html'));
    if (url.pathname.startsWith('/spec/')) return serveFile(res, path.join(__dirname, 'spec', path.basename(url.pathname)));
    if (url.pathname === '/spec') return serveFile(res, path.join(PUBLIC, 'spec.html'));
    if (url.pathname === '/connect') return serveFile(res, path.join(PUBLIC, 'connect.html'));
    if (url.pathname === '/ui' || url.pathname === '/ui/') return serveFile(res, path.join(PUBLIC, 'ui', 'index.html'));
    const f = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!(f === PUBLIC || f.startsWith(PUBLIC + path.sep))) return send(res, 403, 'Forbidden');
    return serveFile(res, f);
  } catch (e) {
    if (!(e instanceof ApiError)) console.error('[http]', e.stack || e.message);
    if (!res.headersSent) send(res, e instanceof ApiError ? e.code : 500, { error: e instanceof ApiError ? e.message : 'Server error' });
  }
});

const onListen = () => console.log(`Proxy Room (PXP/0) on :${server.address().port} · live=${proxy.live()} · model=${proxy.MODEL} · data=${DATA_DIR} · mcp=${PUBLIC_URL}/mcp`);
server.listen(PORT, HOST || undefined, onListen); // unset or empty BIND_HOST binds all interfaces
