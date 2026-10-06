'use strict';
// PXP over MCP: a stateless Streamable HTTP MCP server (JSON responses).
// Any MCP-capable agent can create a room, take a seat, and negotiate under PXP v0.
const { str } = require('./pxp');
const { PLAIN_WRITING } = require('./writing');
const { agentKeyRequired } = require('./errors');

const SERVER_INFO = { name: 'behalf', title: 'Behalf (PXP v0)', version: '0.2.0' };
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// The canonical, published spec (JulesNsenda/pxp), so an agent can read the whole protocol.
const SPEC_URL = 'https://julesnsenda.github.io/pxp/v0/SPEC.md';

// keyClause is what step 1 adds when the server requires sign-in; with none, the text is the one from before sign-in existed.
const KEY_INSTRUCTION = " The seat link is the credential for every tool except create_room; create_room also needs your principal's agent key, sent as an Authorization: Bearer header by your MCP client (never as a tool argument).";
const instructions = (keyClause) => `Behalf implements PXP v0, the Proxy Exchange Protocol. You act as a PROXY for exactly one human (your principal) in a negotiation with another proxy.

How to take part:
1. Your principal gives you a private seat link (https://.../room/ID?seat=A&t=TOKEN). Call join_room with it. Never share the link.${keyClause}
2. If your principal's Intent Card is not sealed, ask them for: goal, must-haves, what you may agree to without asking, must-nevers (hard limits), when you must escalate to them, and facts they know. Do not invent any of it. Show them the card and get a yes, then call seal_intent_card.
3. Loop: call wait_for_turn. When it is your turn, call send_envelope. When the room pauses for your principal, ask them the question verbatim and relay their exact words with answer_escalation.
4. When agreed, call get_brief and tell your principal what was agreed, on whose authority, and which assumptions remain unverified.

Protocol rules you must follow:
- Tag every claim you rely on: "stated" (your principal said it; ref = card clause like "must_never[0]" or "amendment[0]"), "sourced" (ref = named document/system), or "assumed" (you inferred it). If nobody told you, it is assumed.
- Anything the other proxy claimed is never "stated" for you.
- Review every unreviewed claim from the other side: accept, challenge (cannot verify), or conflict (contradicts your card).
- Escalate (status "escalate" with one concrete question) instead of agreeing to anything outside your card, anything that crosses a must_never, any escalate_when condition, or a proposal resting on an unverified assumption that touches a must_have.
- status "agree" accepts the other side's latest proposal exactly. Never agree while raising a conflict.
The server enforces these rules and records every turn in a hash-chained ledger.
The full PXP specification: ${SPEC_URL}

How to write for the people reading:
${PLAIN_WRITING}`;
const INSTRUCTIONS = instructions('');

const LINK_PROP = { type: 'string', description: "Your principal's private seat link (https://.../room/ID?seat=A&t=TOKEN). Keep it secret." };

const CARD_SCHEMA = {
  type: 'object',
  description: "Your principal's Intent Card. Every field must come from your principal, not from you.",
  properties: {
    principal: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' }, org: { type: 'string' } }, required: ['name'] },
    goal: { type: 'string', description: 'One sentence: the outcome your principal wants' },
    must_haves: { type: 'array', items: { type: 'string' } },
    may_agree_to: { type: 'array', items: { type: 'string' } },
    must_never: { type: 'array', items: { type: 'string' } },
    escalate_when: { type: 'array', items: { type: 'string' } },
    known_facts: { type: 'array', items: { type: 'string' } },
  },
  required: ['principal', 'goal', 'must_haves'],
};

const TOOLS = [
  {
    name: 'create_room',
    title: 'Create a Behalf room',
    description: 'Open a new room. Your principal takes seat A, and you get a private invite link for the other person (seat B). Send the invite only to that person. Use this when your principal wants to negotiate with someone and has no room yet.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'What the two sides are aligning on' },
        your_principal: { type: 'string', description: "Your principal's name" },
        counterpart: { type: 'string', description: "The other person's name" },
        counterpart_proxy: { type: 'string', enum: ['external', 'builtin'], description: '"external" (default): they bring their own agent. "builtin": the room provides a Claude proxy for them (only if the server has it enabled).' },
        passcode: { type: 'string', description: 'Only if the server requires one' },
      },
      required: ['topic', 'your_principal', 'counterpart'],
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'join_room',
    title: 'Join a room as a proxy',
    description: "Take your principal's seat with their private link. Returns the room state, your principal's card (if sealed), and what to do next.",
    inputSchema: { type: 'object', properties: { link: LINK_PROP, agent_name: { type: 'string', description: 'How you will be labelled in the room, e.g. "Claude Desktop"' } }, required: ['link'] },
    annotations: { idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'seal_intent_card',
    title: 'Seal the Intent Card',
    description: "Seal your principal's Intent Card. Only after they confirmed every line. Once sealed it cannot change except through escalation answers.",
    inputSchema: { type: 'object', properties: { link: LINK_PROP, card: CARD_SCHEMA }, required: ['link', 'card'] },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'get_room',
    title: 'Read the room',
    description: 'Current state from your seat: status, whose turn, transcript, claims you still need to review, unverified assumptions, and the next action.',
    inputSchema: { type: 'object', properties: { link: LINK_PROP }, required: ['link'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'wait_for_turn',
    title: 'Wait for your turn',
    description: 'Blocks up to timeout_seconds (max 25) until it is your turn, your principal must answer a question, or the room ends. Call it again if it times out.',
    inputSchema: { type: 'object', properties: { link: LINK_PROP, timeout_seconds: { type: 'number', minimum: 1, maximum: 25 } }, required: ['link'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'send_envelope',
    title: 'Take your turn',
    description: 'Send one PXP envelope on your turn. The server enforces the rules: untagged or unreferenced claims become "assumed", agreeing while raising a conflict is refused. The enforced envelope is returned.',
    inputSchema: {
      type: 'object',
      properties: {
        link: LINK_PROP,
        message: { type: 'string', description: 'What the other side and both people will read, in short plain sentences (2-4)' },
        claims: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              origin: { type: 'string', enum: ['stated', 'sourced', 'assumed'] },
              ref: { type: 'string', description: 'Required for stated (card clause, e.g. "must_never[0]", "amendment[0]") and sourced (source name)' },
            },
            required: ['text', 'origin'],
          },
        },
        reviews: {
          type: 'array',
          items: {
            type: 'object',
            properties: { claim_id: { type: 'string' }, verdict: { type: 'string', enum: ['accept', 'challenge', 'conflict'] }, reason: { type: 'string' } },
            required: ['claim_id', 'verdict'],
          },
        },
        proposal: {
          type: 'object',
          properties: {
            terms: { type: 'array', items: { type: 'string' } },
            depends_on: { type: 'array', items: { type: 'string' }, description: 'Claim ids the terms rest on. Use new1, new2 for claims in this envelope.' },
          },
          required: ['terms'],
        },
        status: { type: 'string', enum: ['continue', 'agree', 'escalate'] },
        escalation: { type: 'object', properties: { question: { type: 'string' }, reason: { type: 'string' } }, required: ['question'] },
      },
      required: ['link', 'message', 'status'],
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'answer_escalation',
    title: "Relay your principal's answer",
    description: "When the room is paused for your principal, ask them the question verbatim and relay their exact answer. It is sealed into their card as an amendment. Never answer on their behalf.",
    inputSchema: { type: 'object', properties: { link: LINK_PROP, answer: { type: 'string', description: "Your principal's answer, in their words" } }, required: ['link', 'answer'] },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'get_brief',
    title: 'Read the decision brief',
    description: 'The decision brief once the room has ended: agreed terms, authority per term, unverified assumptions, escalations, ledger head.',
    inputSchema: { type: 'object', properties: { room_id: { type: 'string' }, link: LINK_PROP } },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

// ---------- helpers ----------
function parseLink(ops, link) {
  const raw = String(link || '').trim();
  let u;
  try { u = new URL(raw, ops.PUBLIC_URL); } catch { throw new ops.ApiError(400, 'That is not a valid seat link.'); }
  const m = u.pathname.match(/\/room\/([A-Za-z0-9]+)/);
  const seat = u.searchParams.get('seat');
  const token = u.searchParams.get('t');
  if (!m || !['A', 'B'].includes(seat) || !token) throw new ops.ApiError(400, 'A seat link looks like https://.../room/ID?seat=A&t=TOKEN.');
  const room = ops.rooms.get(m[1]);
  if (!room) throw new ops.ApiError(404, 'Room not found.');
  if (!ops.authSeat(room, seat, token)) throw new ops.ApiError(403, 'This link does not control that seat.');
  return { room, seat, token };
}

function compactEnvelope(e) {
  const out = { seq: e.seq, from: `${e.from.seat} (${e.from.principal}'s proxy${e.from.agent ? ', ' + e.from.agent : ''})`, status: e.status, message: e.message };
  if (e.claims.length) out.claims = e.claims.map(c => ({ id: c.id, origin: c.origin, ref: c.ref, text: c.text }));
  if (e.reviews.length) out.reviews = e.reviews;
  if (e.proposal) out.proposal = { ...e.proposal, hash: e.proposal_hash };
  if (e.accepts) out.accepts = e.accepts;
  if (e.escalation) out.escalation = { question: e.escalation.question, answer: e.answer || null };
  if (e.protocol_flags) out.protocol_flags = e.protocol_flags;
  return out;
}

function agentView(ops, room, seat) {
  const me = room.seats[seat], them = room.seats[ops.other(seat)];
  const claims = Object.values(room.claims);
  const yourTurn = room.status === 'negotiating' && room.waitingOn === seat;
  const pendingForYou = room.pending && room.pending.seat === seat;
  let next;
  if (room.status === 'drafting' && !me.sealed) next = "Ask your principal for every Intent Card field (do not invent any), confirm the card with them, then call seal_intent_card.";
  else if (room.status === 'drafting') next = `Your card is sealed. Waiting for ${them.name || 'the other side'} to seal theirs. Call wait_for_turn.`;
  else if (pendingForYou) next = `Paused for your principal. Ask them exactly this and relay their words with answer_escalation: "${room.pending.question}"`;
  else if (room.pending) next = 'Paused while the other principal answers their proxy. Call wait_for_turn.';
  else if (yourTurn) next = 'Your turn. Review every claim in claims_to_review, then call send_envelope.';
  else if (room.status === 'negotiating') next = "The other side's turn. Call wait_for_turn.";
  else if (room.status === 'agreed') next = 'Agreement reached. Call get_brief and report the terms, authority and unverified assumptions to your principal.';
  else if (room.status === 'stalled') next = room.turnCount < room.maxTurns ? 'No agreement: the room used up its AI allowance. Call get_brief and report to your principal.' : 'No agreement within the turn limit. Call get_brief and report to your principal.';
  else if (room.status === 'error') next = `The room hit an error: ${room.error} Your principal can press Resume in the web view.`;
  else next = 'Call wait_for_turn.';

  return {
    room_id: room.id, topic: room.topic, status: room.status,
    you: { seat, principal: (me.card && me.card.principal.name) || me.name, proxy: me.mode, card_sealed: me.sealed, card: me.card, card_hash: me.cardHash },
    counterpart: { seat: ops.other(seat), principal: (them.card && them.card.principal.name) || them.name, proxy: them.mode === 'external' ? (them.agent || 'external agent (not joined yet)') : 'built-in Claude proxy', card_sealed: them.sealed },
    your_turn: yourTurn,
    pending_question: pendingForYou ? room.pending.question : null,
    next_action: next,
    turn_count: room.turnCount, max_turns: room.maxTurns,
    transcript: room.envelopes.map(compactEnvelope),
    claims_to_review: claims.filter(c => c.seat !== seat && !c.reviews.some(r => r.by === seat)).map(c => ({ id: c.id, origin: c.origin, ref: c.ref, text: c.text })),
    unverified_assumptions: claims.filter(c => !c.verified).map(c => ({ id: c.id, by: c.seat, text: c.text })),
    web_view: ops.seatLink(room, seat),
    brief_url: room.brief ? `${ops.PUBLIC_URL}/brief/${room.id}` : null,
  };
}

function actionable(room, seat) {
  return (room.status === 'drafting' && !room.seats[seat].sealed)
    || (room.status === 'negotiating' && room.waitingOn === seat)
    || (room.pending && room.pending.seat === seat)
    || ['agreed', 'stalled', 'error'].includes(room.status)
    || (room.status === 'paused' && room.interrupted);
}

// With sign-in off the text and the tools are exactly the ones above. With it on, they also say that create_room needs the agent key.
const KEY_DESCRIPTION = " This server requires sign-in: your MCP client must send your principal's agent key as an Authorization: Bearer header (not as an argument).";
const INSTRUCTIONS_SIGNIN = instructions(KEY_INSTRUCTION);
const TOOLS_SIGNIN = TOOLS.map(t => (t.name === 'create_room' ? { ...t, description: t.description + KEY_DESCRIPTION } : t));
const instructionsFor = (signinOn) => (signinOn ? INSTRUCTIONS_SIGNIN : INSTRUCTIONS);
const toolsFor = (signinOn) => (signinOn ? TOOLS_SIGNIN : TOOLS);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- tool implementations ----------
async function callTool(ops, name, args, ctx) {
  args = args || {};
  switch (name) {
    case 'create_room': {
      // With sign-in on, the agent key (the Authorization header, resolved once per request in handle(), never a tool argument) names the
      // owner and the quota. Without a user it is refused here, before the domain, with one of two fixed sentences; the domain's own check
      // is only a backstop. With sign-in off ctx.user is always null and the domain ignores the user.
      if (ops.signinOn && !ctx.user) throw agentKeyRequired(ctx.hasAuthHeader);
      const room = ops.createLiveRoom(ctx.ip, {
        topic: args.topic, nameA: args.your_principal, nameB: args.counterpart,
        modeA: 'external', modeB: args.counterpart_proxy === 'builtin' ? 'builtin' : 'external', passcode: args.passcode,
      }, ctx.user || undefined);
      ops.joinAsAgent(room, 'A', ctx.clientName);
      return {
        room_id: room.id,
        your_link: ops.seatLink(room, 'A'),
        invite_link_for_counterpart: ops.seatLink(room, 'B'),
        counterpart_proxy: room.seats.B.mode,
        next_action: room.seats.B.mode === 'external'
          ? `Give invite_link_for_counterpart privately to ${args.counterpart}. They can open it in a browser, or paste it into their own MCP-capable agent connected to ${ops.PUBLIC_URL}/mcp. Then ask your principal for their Intent Card and call seal_intent_card with your_link.`
          : `Give invite_link_for_counterpart privately to ${args.counterpart}; they brief the built-in proxy in the browser. Then ask your principal for their Intent Card and call seal_intent_card with your_link.`,
      };
    }
    case 'join_room': {
      const { room, seat } = parseLink(ops, args.link);
      ops.joinAsAgent(room, seat, args.agent_name || ctx.clientName);
      return agentView(ops, room, seat);
    }
    case 'seal_intent_card': {
      const { room, seat } = parseLink(ops, args.link);
      if (room.seats[seat].mode !== 'external') ops.joinAsAgent(room, seat, ctx.clientName);
      ops.sealCard(room, seat, args.card, 'mcp');
      return agentView(ops, room, seat);
    }
    case 'get_room': {
      const { room, seat } = parseLink(ops, args.link);
      return agentView(ops, room, seat);
    }
    case 'wait_for_turn': {
      const { room, seat } = parseLink(ops, args.link);
      const ms = Math.min(25, Math.max(1, Number(args.timeout_seconds) || 20)) * 1000;
      const end = Date.now() + ms;
      while (!actionable(room, seat) && Date.now() < end) await sleep(400);
      const v = agentView(ops, room, seat);
      v.timed_out = !actionable(room, seat);
      return v;
    }
    case 'send_envelope': {
      const { room, seat } = parseLink(ops, args.link);
      if (room.seats[seat].mode !== 'external') throw new ops.ApiError(409, 'This seat is driven by the built-in proxy.');
      const raw = {
        message: args.message, claims: args.claims, reviews: args.reviews,
        proposal: args.proposal, status: args.status, escalation: args.escalation,
      };
      const env = await ops.externalTurn(room, seat, raw);
      return { accepted_envelope: compactEnvelope(env), room: agentView(ops, room, seat) };
    }
    case 'answer_escalation': {
      const { room, seat } = parseLink(ops, args.link);
      ops.answerEscalation(room, seat, args.answer, 'mcp');
      await sleep(50);
      return agentView(ops, room, seat);
    }
    case 'get_brief': {
      let room;
      if (args.link) room = parseLink(ops, args.link).room;
      else room = ops.rooms.get(str(args.room_id, 20));
      if (!room) throw new ops.ApiError(404, 'Room not found.');
      if (!room.brief) return { status: room.status, brief: null, note: 'No brief yet. The room has not ended.' };
      return { status: room.status, brief_url: `${ops.PUBLIC_URL}/brief/${room.id}`, brief: room.brief };
    }
    default:
      throw new ops.ApiError(404, `Unknown tool: ${name}`);
  }
}

// ---------- JSON-RPC over Streamable HTTP ----------
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }; }

async function dispatch(ops, msg, ctx) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg && msg.id, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined || msg.id === null;
  const p = msg.params || {};
  try {
    let result;
    switch (msg.method) {
      case 'initialize': {
        const requested = p.protocolVersion;
        result = {
          protocolVersion: VERSIONS.includes(requested) ? requested : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: instructionsFor(ops.signinOn),
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: toolsFor(ops.signinOn) }; break;
      case 'tools/call': {
        try {
          const out = await callTool(ops, p.name, p.arguments, ctx);
          result = { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
        } catch (e) {
          if (!(e instanceof ops.ApiError)) ops.log.error('mcp.tool_failed', {}, e);
          result = { content: [{ type: 'text', text: e instanceof ops.ApiError ? e.message : 'Server error' }], isError: true };
        }
        break;
      }
      default:
        if (msg.method.startsWith('notifications/')) return null;
        return isNotification ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
    return isNotification ? null : { jsonrpc: '2.0', id: msg.id, result };
  } catch (e) {
    ops.log.error('mcp.dispatch_failed', {}, e);
    return isNotification ? null : rpcError(msg.id, -32603, 'Internal error');
  }
}

const BODY_LIMIT = 256 * 1024; // largest POST body handle() reads

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-session-id, authorization, accept',
  'access-control-expose-headers': 'mcp-session-id',
};

// Remember each client's name per MCP session so seats get a readable agent label.
const sessions = new Map(); // session id -> client name
function rememberSession(name) {
  const sid = require('crypto').randomUUID();
  sessions.set(sid, name);
  if (sessions.size > 5000) sessions.delete(sessions.keys().next().value);
  return sid;
}

const MAX_BATCH = 20; // most messages one POST may carry; a bigger batch is refused before anything is dispatched

async function handle(req, res, ops, { readBody, clientIp }) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const sid = String(req.headers['mcp-session-id'] || '');
  if (req.method === 'DELETE') { sessions.delete(sid); res.writeHead(200, CORS); return res.end(); }
  if (req.method !== 'POST') {
    // No server-initiated stream: every response comes back on the POST that asked for it.
    res.writeHead(405, { ...CORS, allow: 'POST, DELETE, OPTIONS', 'content-type': 'application/json' });
    return res.end(JSON.stringify(rpcError(null, -32000, 'Method not allowed. POST JSON-RPC to this endpoint.')));
  }
  let body;
  try { body = await readBody(req, BODY_LIMIT); }
  catch (e) {
    // Too large (declared or streamed): a 413 the client can read. Anything else is unparseable JSON.
    if (e instanceof ops.ApiError && e.code === 413) { res.writeHead(413, { ...CORS, 'content-type': 'application/json', connection: 'close' }); return res.end(JSON.stringify(rpcError(null, -32600, 'Body too large'))); }
    res.writeHead(400, { ...CORS, 'content-type': 'application/json' }); return res.end(JSON.stringify(rpcError(null, -32700, 'Parse error'))); }

  // The agent key is only ever read from this header (never an argument), and is never logged.
  const authHeader = String(req.headers.authorization || '');
  const bearer = /^Bearer ([^\s]+)$/i.exec(authHeader);
  // The key is resolved once per request, whatever the tool, so every use refreshes its lastUsedAt (saved at most daily): it idles out
  // 90 days after its last use, not after its last create_room. A key that does not resolve is only an error where one is needed.
  const ctx = { ip: clientIp(req), clientName: sessions.get(sid) || 'MCP agent', hasAuthHeader: authHeader !== '', user: bearer ? ops.userForAgentKey(bearer[1]) : null };
  const msgs = Array.isArray(body) ? body : [body];
  if (Array.isArray(body) && body.length > MAX_BATCH) {
    res.writeHead(400, { ...CORS, 'content-type': 'application/json' });
    return res.end(JSON.stringify(rpcError(null, -32600, 'Batch too large')));
  }
  const headers = { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' };
  const init = msgs.find(m => m && m.method === 'initialize');
  if (init) {
    const ci = init.params && init.params.clientInfo;
    ctx.clientName = str((ci && (ci.title || ci.name)) || 'MCP agent', 60);
    headers['mcp-session-id'] = rememberSession(ctx.clientName);
  }
  const results = (await Promise.all(msgs.map(m => dispatch(ops, m, ctx)))).filter(Boolean);

  if (!results.length) { res.writeHead(202, CORS); return res.end(); }
  res.writeHead(200, headers);
  res.end(JSON.stringify(Array.isArray(body) ? results : results[0]));
}

const sessionCount = () => sessions.size; // test-only: lets a test prove a refused request opened no session

module.exports = { handle, MAX_BATCH, sessionCount, TOOLS, INSTRUCTIONS, toolsFor, instructionsFor, BODY_LIMIT, SERVER_INFO, SPEC_URL };
