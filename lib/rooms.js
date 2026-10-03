'use strict';
// The domain layer: room lifecycle, the turn loop, quota. It never touches HTTP.
// Invariant: every op is synchronous and ends by calling run() synchronously, so the status has flipped before the
// caller responds. The ops are ordered by JavaScript's run-to-completion; the only hazard is state that changes during
// an await (advance, finalise, a draft), so code after an await must not assume what it saw before it.
const crypto = require('crypto');
const pxp = require('./pxp');

const id = (n = 8) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n + 2);
const defaultClock = { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) };
const agentLabel = seat => seat.agent || 'External agent';
const proxyLabel = seat => (seat.mode === 'external' ? agentLabel(seat) : 'Built-in Claude proxy');
const other = s => (s === 'A' ? 'B' : 'A');

class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function newSeat() {
  return { token: id(16), name: '', card: null, cardHash: null, sealed: false, draftText: '', mode: 'builtin', agent: null };
}

function createRooms({ config, secrets, store, proxy, demo, log, clock = defaultClock }) {
  const now = clock.now || defaultClock.now;
  const sleep = clock.sleep || defaultClock.sleep;
  const iso = () => new Date(now()).toISOString();
  const today = () => iso().slice(0, 10);
  const { dailyRoomLimit: DAILY_ROOM_LIMIT, perIpDaily: PER_IP_DAILY, maxTurns: MAX_TURNS, demoDelayMs: DEMO_DELAY, publicUrl: PUBLIC_URL } = config;
  const PASSCODE = secrets.passcode;
  const rooms = store.state.rooms;
  const usage = store.state.usage;
  const listeners = [];
  let stopped = false;

  const seatLink = (room, s) => `${PUBLIC_URL}/room/${room.id}?seat=${s}&t=${room.seats[s].token}`;

  // The restart rules, applied once after the store has loaded.
  function hydrate() {
    for (const r of rooms.values()) {
      r.running = false; r.thinking = null;
      // A built-in turn in flight is lost on restart; an external seat is simply still waiting.
      if (r.status === 'negotiating' && !r.waitingOn) { r.status = 'paused'; r.interrupted = true; }
    }
  }

  // fn(room, kind); kind is 'change' for now. Returns the unsubscribe function.
  function onChange(fn) {
    listeners.push(fn);
    return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  // For tests and shutdown: run() takes no further turns, and listeners hear nothing more from a stopped run.
  function stop() { stopped = true; }

  function emit(room) {
    room.version = (room.version || 0) + 1;
    store.save(room.id);
    for (const fn of listeners) {
      try { fn(room, 'change'); } catch (e) { log.error('room.listener_failed', { room: room.id }, e); }
    }
  }

  // The turn cap also clears waitingOn and records turn_limit; running out of script only stalls the room.
  function stall(room, { turnLimit }) {
    room.status = 'stalled';
    if (turnLimit) {
      room.waitingOn = null;
      pxp.appendLedger(room, 'turn_limit', { turns: room.turnCount });
    }
    room.brief = buildBrief(room, {});
  }

  // names, modes and cards are optional { A, B } maps.
  function createRoom({ topic, demoMode, names, modes, cards }) {
    const room = {
      id: id(8), topic: pxp.str(topic, 160) || 'Untitled room', demo: Boolean(demoMode),
      createdAt: iso(), status: 'drafting',
      seats: { A: newSeat(), B: newSeat() }, envelopes: [], claims: {}, ledger: [],
      turn: 'A', turnCount: 0, maxTurns: MAX_TURNS, pending: null, brief: null, error: null, waitingOn: null,
    };
    if (room.demo) room.seats.B.token = room.seats.A.token; // one person drives both seats in the demo
    for (const s of ['A', 'B']) {
      if (names) room.seats[s].name = names[s];
      if (modes) room.seats[s].mode = modes[s];
      if (cards) room.seats[s].card = cards[s];
    }
    pxp.appendLedger(room, 'room_opened', { topic: room.topic, protocol: 'PXP/0' });
    rooms.set(room.id, room);
    store.save(room.id);
    return room;
  }

  function createDemoRoom() {
    return createRoom({ topic: demo.topic, demoMode: true, cards: { A: pxp.normaliseCard(demo.cards.A), B: pxp.normaliseCard(demo.cards.B) } });
  }

  function takeQuota(ip) {
    if (usage.day !== today()) store.resetUsage(today());
    if (usage.total >= DAILY_ROOM_LIMIT) return 'Daily room limit reached. Try again tomorrow, or run the demo.';
    if ((usage.byIp[ip] || 0) >= PER_IP_DAILY) return 'You have opened the maximum live rooms for today. The demo is unlimited.';
    usage.total++; usage.byIp[ip] = (usage.byIp[ip] || 0) + 1;
    store.save();
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
    return createRoom({ topic, names: { A: pxp.str(nameA, 80), B: pxp.str(nameB, 80) }, modes });
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

  // Ask Claude to draft the seat's card from a plain-language brief. Resolves with the card.
  // The markers in test/room-view.test.js rely on this order: draftCard..answerEscalation, resume..startIfReady.
  async function draftCard(room, seatId, body) {
    const seat = room.seats[seatId];
    if (seat.sealed) throw new ApiError(409, 'Card already sealed.');
    if (room.demo) throw new ApiError(400, 'Demo cards are pre-filled.');
    if (!proxy.live()) throw new ApiError(503, 'Drafting with Claude is not enabled on this server. Fill in the card yourself.');
    const text = pxp.str(body.text, 4000);
    const name = pxp.str(body.name, 80) || seat.name;
    if (!text || !name) throw new ApiError(400, 'Add your name and a brief.');
    seat.name = name; seat.draftText = text;
    seat.drafts = (seat.drafts || 0) + 1;
    if (seat.drafts > 5) throw new ApiError(429, 'Draft limit reached for this seat. Edit the card directly.');
    try {
      const out = await proxy.draftCard({ name, role: pxp.str(body.role, 120), topic: room.topic, text });
      out.principal = { ...(out.principal || {}), name };
      seat.card = pxp.normaliseCard(out, name);
    } catch (e) { throw new ApiError(502, 'Could not draft the card: ' + e.message); }
    emit(room);
    return seat.card;
  }

  function answerEscalation(room, seatId, answer, via) {
    assertPending(room, seatId);
    answer = pxp.str(answer, 1000);
    if (!answer) throw new ApiError(400, 'Write an answer for your proxy.');
    const env = room.envelopes.find(e => e.seq === room.pending.seq);
    if (env) { env.answer = answer; env.answer_via = via; }
    const seat = room.seats[seatId];
    seat.card.amendments.push({ question: room.pending.question, answer, at: iso() });
    seat.cardHash = pxp.hashOf(seat.card);
    pxp.appendLedger(room, 'principal_answer', { seat: seatId, speaker: 'principal', via, answer_hash: pxp.sha256(answer), card_hash: seat.cardHash });
    room.pending = null;
    room.turn = seatId; // the proxy that escalated resumes
    run(room);
  }

  function assertPending(room, seatId) {
    if (!room.pending || room.pending.seat !== seatId) throw new ApiError(409, 'No question is waiting for this seat.');
  }

  // The web answer route in a demo room: the chosen option picks the scripted branch, then the scripted answer follows.
  function answerDemo(room, seatId, option) {
    assertPending(room, seatId);
    const key = Object.prototype.hasOwnProperty.call(demo.choices, option) ? option : 'dedupe';
    room.branch = key;
    room.script = demo.branches[key].slice();
    answerEscalation(room, seatId, demo.answers[key], 'web');
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
    } catch (e) { log.error('brief.authority_failed', { room: room.id }, e); }

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
    const party = s => ({ name: room.seats[s].card.principal.name, card_hash: room.seats[s].cardHash, proxy: proxyLabel(room.seats[s]) });
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
      generated_at: iso(),
    };
  }

  // Apply one proxy turn (from either kind of proxy) through protocol enforcement.
  async function advance(room, seatId, raw) {
    const env = pxp.buildEnvelope(room, seatId, raw);
    if (room.seats[seatId].mode === 'external') env.from.agent = agentLabel(room.seats[seatId]);
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
    if (room.running || stopped) return;
    room.running = true;
    room.status = 'negotiating';
    room.interrupted = false;
    room.error = null;
    try {
      while (room.status === 'negotiating' && !stopped) {
        if (room.turnCount >= room.maxTurns) {
          stall(room, { turnLimit: true });
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
          if (stopped) break;
          const step = room.script.shift();
          if (!step) { stall(room, { turnLimit: false }); break; }
          raw = step.raw;
        } else {
          raw = await proxy.takeTurn(room, seatId);
          if (stopped) break;
        }
        await advance(room, seatId, raw);
      }
    } catch (e) {
      log.error('room.run_failed', { room: room.id }, e);
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

  function resume(room) {
    if (!['error', 'paused'].includes(room.status) || room.pending) throw new ApiError(409, 'Nothing to resume.');
    run(room);
  }

  function startIfReady(room) {
    if (room.seats.A.sealed && room.seats.B.sealed && room.status === 'drafting') {
      if (room.demo) room.script = demo.opening.slice();
      run(room);
    }
  }

  return {
    rooms, ApiError, other, seatLink, hydrate, onChange,
    createDemoRoom, createLiveRoom, draftCard, sealCard, joinAsAgent,
    answerEscalation, answerDemo, externalTurn, resume, stop,
  };
}

module.exports = { createRooms, ApiError };
