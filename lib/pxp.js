'use strict';
// PXP v0 core: canonical hashing, sealing, ledger, claim bookkeeping.
const crypto = require('crypto');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function hashOf(obj) {
  return sha256(canonical(obj));
}

// What the person sees when an AI escalates without a question of its own.
const ESCALATION_FALLBACK = 'Your AI needs a decision before it can continue.';

const LIST_FIELDS = ['must_haves', 'may_agree_to', 'must_never', 'escalate_when', 'known_facts'];

const isPrimitive = (x) => x == null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';

function str(v, max = 500) {
  // Only primitives are coerced (an object can carry a hostile toString), and so are arrays of primitives, which have
  // always read as their comma-joined items. Anything else is empty.
  let out = '';
  if (typeof v === 'string') out = v;
  else if (typeof v === 'number' || typeof v === 'boolean') out = String(v);
  else if (Array.isArray(v) && v.every(isPrimitive)) out = v.join(',');
  return out.trim().slice(0, max);
}

// Normalise anything that claims to be an Intent Card into a valid v0 card.
function normaliseCard(input, fallbackName) {
  const c = input && typeof input === 'object' ? input : {};
  const p = c.principal && typeof c.principal === 'object' ? c.principal : {};
  const card = {
    pxp: '0',
    principal: { name: str(p.name, 80) || str(fallbackName, 80) || 'Unnamed', role: str(p.role, 120) },
    goal: str(c.goal, 400),
  };
  if (str(p.org, 120)) card.principal.org = str(p.org, 120);
  for (const f of LIST_FIELDS) {
    const arr = Array.isArray(c[f]) ? c[f] : typeof c[f] === 'string' ? c[f].split('\n') : [];
    card[f] = arr.map(x => str(x, 300)).filter(Boolean).slice(0, 12);
  }
  card.amendments = []; // only escalation answers add amendments (SPEC), never the input
  return card;
}

function validateCard(card) {
  const errs = [];
  if (!card.goal) errs.push('goal is required');
  if (!card.must_haves.length) errs.push('add at least one must-have');
  return errs;
}

// Append-only, hash-chained ledger.
function appendLedger(room, type, data) {
  const prev = room.ledger.length ? room.ledger[room.ledger.length - 1].hash : '0'.repeat(64);
  const entry = { n: room.ledger.length + 1, type, at: new Date().toISOString(), data };
  entry.prev = prev;
  entry.hash = sha256(prev + canonical({ n: entry.n, type, at: entry.at, data }));
  room.ledger.push(entry);
  return entry;
}

function verifyLedger(ledger) {
  let prev = '0'.repeat(64);
  for (const e of ledger) {
    const h = sha256(prev + canonical({ n: e.n, type: e.type, at: e.at, data: e.data }));
    if (e.prev !== prev || e.hash !== h) return { ok: false, brokenAt: e.n };
    prev = e.hash;
  }
  return { ok: true, head: prev };
}

const ORIGINS = new Set(['stated', 'sourced', 'assumed']);
const VERDICTS = new Set(['accept', 'challenge', 'conflict']);
const STATUSES = new Set(['continue', 'agree', 'escalate']);

// Turn a raw proxy output into a protocol-valid envelope, enforcing PXP rules
// server-side so a misbehaving model cannot launder an assumption.
function buildEnvelope(room, seatId, raw) {
  const seat = room.seats[seatId];
  const other = seatId === 'A' ? 'B' : 'A';
  const seq = room.envelopes.length + 1;
  const flags = [];
  const r = raw && typeof raw === 'object' ? raw : {};

  const claims = (Array.isArray(r.claims) ? r.claims : []).slice(0, 8).map((c, i) => {
    let origin = ORIGINS.has(c && c.origin) ? c.origin : 'assumed';
    const ref = str(c && c.ref, 160);
    const text = str(c && c.text, 400);
    // Rule: stated and sourced must cite a ref, otherwise they are assumptions.
    if ((origin === 'stated' || origin === 'sourced') && !ref) {
      flags.push(`Claim "${text.slice(0, 60)}" was tagged ${origin} without a reference; downgraded to assumed.`);
      origin = 'assumed';
    }
    // Rule: a claim that only repeats the other side cannot become "stated" for us.
    if (origin === 'stated' && /^(other|their|counterpart|B|A)\b/i.test(ref)) {
      flags.push(`Claim "${text.slice(0, 60)}" cited the other side as its authority; downgraded to assumed.`);
      origin = 'assumed';
    }
    return { id: `${seatId}${seq}.${i + 1}`, text, origin, ref: ref || undefined };
  }).filter(c => c.text);

  const known = new Set(Object.values(room.claims).filter(c => c.seat === other).map(c => c.id));
  const reviews = (Array.isArray(r.reviews) ? r.reviews : []).map(v => ({
    claim_id: str(v && v.claim_id, 20),
    verdict: VERDICTS.has(v && v.verdict) ? v.verdict : 'challenge',
    reason: str(v && v.reason, 300),
  })).filter(v => known.has(v.claim_id));

  let status = STATUSES.has(r.status) ? r.status : 'continue';
  let proposal;
  if (r.proposal && Array.isArray(r.proposal.terms) && r.proposal.terms.length) {
    proposal = {
      terms: r.proposal.terms.map(t => str(t, 300)).filter(Boolean).slice(0, 10),
      depends_on: (Array.isArray(r.proposal.depends_on) ? r.proposal.depends_on : []).map(x => str(x, 20)),
    };
    // Allow depending on claims made in this very envelope.
    const local = new Map(claims.map((c, i) => [`new${i + 1}`, c.id]));
    proposal.depends_on = proposal.depends_on.map(d => local.get(d) || d);
  }

  // Rule: you cannot agree while raising a conflict.
  if (status === 'agree' && reviews.some(v => v.verdict === 'conflict')) {
    flags.push('Proxy tried to agree while flagging a conflict; agreement withheld.');
    status = 'continue';
  }
  // Rule: "agree" accepts the other side's latest proposal. Nothing to accept → continue.
  let accepts;
  if (status === 'agree') {
    const lastOther = [...room.envelopes].reverse().find(e => e.from.seat === other && e.proposal);
    // Claims this proxy disputed (challenge or conflict), including in this envelope, unless its
    // principal answered an escalation after the dispute. A human ruling clears the block; the
    // claim stays unverified and is carried into the brief.
    const ruledAfter = s => room.envelopes.some(e => e.from.seat === seatId && e.escalation && e.answer && e.seq >= s);
    const disputed = new Set(reviews.filter(v => v.verdict !== 'accept').map(v => v.claim_id));
    for (const c of Object.values(room.claims)) {
      const last = c.reviews.filter(rv => rv.by === seatId && rv.verdict !== 'accept').pop();
      if (last && !ruledAfter(last.seq)) disputed.add(c.id);
    }
    const blocking = lastOther ? lastOther.proposal.depends_on.filter(d => disputed.has(d)) : [];
    if (!lastOther) {
      flags.push('Proxy agreed but there was no proposal from the other side; treated as continue.');
      status = 'continue';
    } else if (blocking.length) {
      // Rule: you cannot accept a proposal that rests on a claim you disputed.
      flags.push(`Proxy tried to accept a proposal resting on ${blocking.join(', ')}, which it disputed; agreement withheld.`);
      status = 'continue';
    } else {
      accepts = { seq: lastOther.seq, proposal_hash: lastOther.proposal_hash };
      proposal = undefined;
    }
  }

  let escalation;
  if (status === 'escalate') {
    escalation = {
      question: str(r.escalation && r.escalation.question, 400) || ESCALATION_FALLBACK,
      reason: str(r.escalation && r.escalation.reason, 400),
    };
  }

  const env = {
    pxp: '0',
    room: room.id,
    seq,
    from: { seat: seatId, principal: seat.card.principal.name, speaker: 'proxy' },
    intent_hash: seat.cardHash,
    message: str(r.message, 1500),
    claims,
    reviews,
    status,
  };
  if (proposal) { env.proposal = proposal; env.proposal_hash = hashOf(proposal.terms); }
  if (accepts) env.accepts = accepts;
  if (escalation) env.escalation = escalation;
  if (flags.length) env.protocol_flags = flags;
  return env;
}

// Apply an envelope to room state: claims registry, reviews, ledger.
function applyEnvelope(room, env) {
  room.envelopes.push(env);
  for (const c of env.claims) {
    room.claims[c.id] = { ...c, seat: env.from.seat, seq: env.seq, verified: c.origin !== 'assumed', reviews: [] };
  }
  for (const v of env.reviews) {
    const c = room.claims[v.claim_id];
    if (c) c.reviews.push({ by: env.from.seat, verdict: v.verdict, reason: v.reason, seq: env.seq });
  }
  appendLedger(room, 'envelope', { seq: env.seq, seat: env.from.seat, status: env.status, envelope_hash: hashOf(env) });
}

module.exports = { canonical, sha256, hashOf, normaliseCard, validateCard, appendLedger, verifyLedger, buildEnvelope, applyEnvelope, LIST_FIELDS, str };
