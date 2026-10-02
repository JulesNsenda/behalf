'use strict';
// Characterisation tests for lib/pxp.js: today's behaviour, pinned. Invariants only, never literal hashes or timestamps.
const { test } = require('node:test');
const assert = require('node:assert');
const pxp = require('../lib/pxp');

// The protocol_flags sentences. The UI parses them, so they are a frozen contract: change them here only on purpose.
const FLAG = {
  noRef: (text, origin) => `Claim "${text}" was tagged ${origin} without a reference; downgraded to assumed.`,
  otherSide: (text) => `Claim "${text}" cited the other side as its authority; downgraded to assumed.`,
  conflict: 'Proxy tried to agree while flagging a conflict; agreement withheld.',
  noProposal: 'Proxy agreed but there was no proposal from the other side; treated as continue.',
  disputed: (ids) => `Proxy tried to accept a proposal resting on ${ids}, which it disputed; agreement withheld.`,
};

const card = (name) => pxp.normaliseCard({ principal: { name, role: 'tester' }, goal: 'g', must_haves: ['m'] });
const raw = (o) => Object.assign({ message: 'm', status: 'continue' }, o);

function mkRoom() {
  const room = { id: 'room1', seats: {}, envelopes: [], claims: {}, ledger: [] };
  for (const s of ['A', 'B']) {
    const c = card('Person ' + s);
    room.seats[s] = { card: c, cardHash: pxp.hashOf(c), sealed: true };
  }
  return room;
}

// Build, apply and return an envelope, the way index.js advance() does.
function turn(room, seat, o) {
  const env = pxp.buildEnvelope(room, seat, o);
  pxp.applyEnvelope(room, env);
  return env;
}

// B states a claim and proposes terms resting on it.
function proposedRoom() {
  const room = mkRoom();
  turn(room, 'B', raw({ claims: [{ text: 'shaky', origin: 'assumed' }], proposal: { terms: ['t'], depends_on: ['new1'] } }));
  return room;
}

// ... and A challenges that claim.
function disputedRoom() {
  const room = proposedRoom();
  turn(room, 'A', raw({ reviews: [{ claim_id: 'B1.1', verdict: 'challenge', reason: 'cannot verify' }] }));
  return room;
}

// ---------- canonical ----------

test('canonical sorts object keys at every depth', () => {
  assert.strictEqual(pxp.canonical({ b: 1, a: { d: 1, c: 2 } }), pxp.canonical({ a: { c: 2, d: 1 }, b: 1 }));
  assert.strictEqual(pxp.canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('canonical drops undefined values but keeps null', () => {
  assert.strictEqual(pxp.canonical({ a: undefined, b: null }), '{"b":null}');
  assert.strictEqual(pxp.canonical({ a: undefined }), '{}');
});

test('canonical keeps array order and canonicalises elements', () => {
  assert.strictEqual(pxp.canonical([2, 1, { b: 1, a: 2 }]), '[2,1,{"a":2,"b":1}]');
  assert.notStrictEqual(pxp.canonical([1, 2]), pxp.canonical([2, 1]));
});

// ---------- ledger ----------

function ledgerRoom(n) {
  const room = { ledger: [] };
  for (let i = 0; i < n; i++) pxp.appendLedger(room, 'evt', { i });
  return room;
}

test('appendLedger chains entries and verifyLedger accepts the chain', () => {
  const room = ledgerRoom(3);
  assert.deepStrictEqual(room.ledger.map((e) => e.n), [1, 2, 3]);
  assert.strictEqual(room.ledger[0].prev, '0'.repeat(64));
  assert.strictEqual(room.ledger[1].prev, room.ledger[0].hash);
  assert.strictEqual(room.ledger[2].prev, room.ledger[1].hash);
  const check = pxp.verifyLedger(room.ledger);
  assert.strictEqual(check.ok, true);
  assert.strictEqual(check.head, room.ledger[2].hash);
});

test('verifyLedger accepts an empty ledger', () => {
  assert.strictEqual(pxp.verifyLedger([]).ok, true);
});

test('verifyLedger detects edited data', () => {
  const room = ledgerRoom(3);
  room.ledger[1].data = { i: 99 };
  const check = pxp.verifyLedger(room.ledger);
  assert.strictEqual(check.ok, false);
  assert.strictEqual(check.brokenAt, 2);
});

test('verifyLedger detects an edited prev', () => {
  const room = ledgerRoom(3);
  room.ledger[2].prev = 'f'.repeat(64);
  const check = pxp.verifyLedger(room.ledger);
  assert.strictEqual(check.ok, false);
  assert.strictEqual(check.brokenAt, 3);
});

test('verifyLedger detects reordered entries', () => {
  const room = ledgerRoom(3);
  const l = room.ledger;
  [l[0], l[1]] = [l[1], l[0]];
  assert.strictEqual(pxp.verifyLedger(l).ok, false);
});

test('verifyLedger detects a dropped first entry', () => {
  const room = ledgerRoom(3);
  assert.strictEqual(pxp.verifyLedger(room.ledger.slice(1)).ok, false);
});

// ---------- buildEnvelope: claim rules ----------

for (const origin of ['stated', 'sourced']) {
  test(`${origin} claim without a ref is downgraded to assumed, with the exact flag`, () => {
    for (const ref of [undefined, '', '   ']) {
      const env = pxp.buildEnvelope(mkRoom(), 'A', raw({ claims: [{ text: 'x', origin, ref }] }));
      assert.strictEqual(env.claims[0].origin, 'assumed', 'ref ' + JSON.stringify(ref));
      assert.deepStrictEqual(env.protocol_flags, [FLAG.noRef('x', origin)], 'ref ' + JSON.stringify(ref));
    }
  });
}

test('stated claim with a ref keeps its origin and raises no flag', () => {
  const env = pxp.buildEnvelope(mkRoom(), 'A', raw({ claims: [{ text: 'x', origin: 'stated', ref: 'must_never[0]' }] }));
  assert.strictEqual(env.claims[0].origin, 'stated');
  assert.strictEqual(env.protocol_flags, undefined);
});

// Only refs that genuinely point at the counterpart. (Known gap, a follow-up: the seat-letter match
// is case-insensitive, so an ordinary ref such as "a signed contract" is also caught; deliberately not pinned here.)
test('stated claim citing the other side is downgraded to assumed, with the exact flag', () => {
  const cases = [['A', 'other side said so'], ['A', 'their message'], ['A', 'counterpart'], ['A', 'B'], ['B', 'A']];
  for (const [seat, ref] of cases) {
    const env = pxp.buildEnvelope(mkRoom(), seat, raw({ claims: [{ text: 'x', origin: 'stated', ref }] }));
    assert.strictEqual(env.claims[0].origin, 'assumed', seat + ' ref ' + ref);
    assert.deepStrictEqual(env.protocol_flags, [FLAG.otherSide('x')], seat + ' ref ' + ref);
  }
});

test('sourced claim citing the other side is not downgraded (the rule covers stated only)', () => {
  const env = pxp.buildEnvelope(mkRoom(), 'A', raw({ claims: [{ text: 'x', origin: 'sourced', ref: 'other' }] }));
  assert.strictEqual(env.claims[0].origin, 'sourced');
});

test('claim ids are seat + seq + index, and empty-text claims are dropped', () => {
  const env = pxp.buildEnvelope(mkRoom(), 'A', raw({ claims: [{ text: 'one', origin: 'assumed' }, { text: '', origin: 'assumed' }, { text: 'two', origin: 'assumed' }] }));
  assert.strictEqual(env.seq, 1);
  assert.deepStrictEqual(env.claims.map((c) => c.text), ['one', 'two']);
  assert.strictEqual(env.claims[0].id, 'A1.1');
});

// ---------- buildEnvelope: reviews ----------

test('reviews of unknown claim ids and of your own claims are filtered out', () => {
  const room = mkRoom();
  turn(room, 'B', raw({ claims: [{ text: 'theirs', origin: 'assumed' }] }));
  turn(room, 'A', raw({ claims: [{ text: 'mine', origin: 'assumed' }] }));
  const env = pxp.buildEnvelope(room, 'A', raw({
    reviews: [
      { claim_id: 'B1.1', verdict: 'accept' },
      { claim_id: 'Z9.9', verdict: 'accept' },
      { claim_id: 'A2.1', verdict: 'accept' },
    ],
  }));
  assert.deepStrictEqual(env.reviews.map((v) => v.claim_id), ['B1.1']);
});

test('an unknown verdict becomes challenge', () => {
  const room = mkRoom();
  turn(room, 'B', raw({ claims: [{ text: 'theirs', origin: 'assumed' }] }));
  const env = pxp.buildEnvelope(room, 'A', raw({ reviews: [{ claim_id: 'B1.1', verdict: 'nonsense' }] }));
  assert.strictEqual(env.reviews[0].verdict, 'challenge');
});

// ---------- buildEnvelope: proposals ----------

test('newN in depends_on maps to this envelope\'s claim ids', () => {
  const env = pxp.buildEnvelope(mkRoom(), 'A', raw({
    claims: [{ text: 'one', origin: 'assumed' }, { text: 'two', origin: 'assumed' }],
    proposal: { terms: ['t'], depends_on: ['new2', 'new1', 'B7.7', 'new9'] },
  }));
  assert.deepStrictEqual(env.proposal.depends_on, [env.claims[1].id, env.claims[0].id, 'B7.7', 'new9']);
  assert.strictEqual(typeof env.proposal_hash, 'string');
  assert.strictEqual(env.proposal_hash, pxp.hashOf(env.proposal.terms));
});

test('a proposal without terms is dropped', () => {
  const env = pxp.buildEnvelope(mkRoom(), 'A', raw({ proposal: { terms: [] } }));
  assert.strictEqual(env.proposal, undefined);
  assert.strictEqual(env.proposal_hash, undefined);
});

// ---------- buildEnvelope: agree rules ----------

test('agree while raising a conflict becomes continue, with the exact flag', () => {
  const room = mkRoom();
  turn(room, 'B', raw({ claims: [{ text: 'theirs', origin: 'assumed' }], proposal: { terms: ['t'], depends_on: [] } }));
  const env = pxp.buildEnvelope(room, 'A', raw({ status: 'agree', reviews: [{ claim_id: 'B1.1', verdict: 'conflict', reason: 'no' }] }));
  assert.strictEqual(env.status, 'continue');
  assert.strictEqual(env.accepts, undefined);
  assert.deepStrictEqual(env.protocol_flags, [FLAG.conflict]);
});

test('agree with no proposal from the other side becomes continue, with the exact flag', () => {
  const room = mkRoom();
  // A proposal from our own seat does not count.
  turn(room, 'A', raw({ proposal: { terms: ['mine'], depends_on: [] } }));
  const env = pxp.buildEnvelope(room, 'A', raw({ status: 'agree' }));
  assert.strictEqual(env.status, 'continue');
  assert.strictEqual(env.accepts, undefined);
  assert.deepStrictEqual(env.protocol_flags, [FLAG.noProposal]);
});

test('agree on the other side\'s latest proposal is accepted and points at it', () => {
  const room = mkRoom();
  const first = turn(room, 'B', raw({ proposal: { terms: ['old'], depends_on: [] } }));
  const latest = turn(room, 'B', raw({ proposal: { terms: ['new'], depends_on: [] } }));
  const env = pxp.buildEnvelope(room, 'A', raw({ status: 'agree', proposal: { terms: ['ignored'], depends_on: [] } }));
  assert.strictEqual(env.status, 'agree');
  assert.deepStrictEqual(env.accepts, { seq: latest.seq, proposal_hash: latest.proposal_hash });
  assert.notStrictEqual(env.accepts.proposal_hash, first.proposal_hash);
  assert.strictEqual(env.proposal, undefined, 'an accepting envelope carries no proposal of its own');
  assert.strictEqual(env.protocol_flags, undefined);
});

test('agree on a proposal resting on a claim this seat disputed is withheld, with the exact flag', () => {
  const env = pxp.buildEnvelope(disputedRoom(), 'A', raw({ status: 'agree' }));
  assert.strictEqual(env.status, 'continue');
  assert.strictEqual(env.accepts, undefined);
  assert.deepStrictEqual(env.protocol_flags, [FLAG.disputed('B1.1')]);
});

test('a dispute raised in the same envelope also blocks agreement', () => {
  const env = pxp.buildEnvelope(proposedRoom(), 'A', raw({ status: 'agree', reviews: [{ claim_id: 'B1.1', verdict: 'challenge' }] }));
  assert.strictEqual(env.status, 'continue');
  assert.deepStrictEqual(env.protocol_flags, [FLAG.disputed('B1.1')]);
});

test('a dispute keeps blocking through later turns that do not involve an answered escalation', () => {
  const room = disputedRoom();
  turn(room, 'A', raw());
  assert.strictEqual(pxp.buildEnvelope(room, 'A', raw({ status: 'agree' })).status, 'continue');
});

test('an escalation answered by the principal after the dispute unblocks agreement', () => {
  const room = disputedRoom();
  const esc = turn(room, 'A', raw({ status: 'escalate', escalation: { question: 'ok?' } }));
  assert.strictEqual(esc.status, 'escalate');
  // Still withheld until the principal has answered.
  assert.strictEqual(pxp.buildEnvelope(room, 'A', raw({ status: 'agree' })).status, 'continue');
  esc.answer = 'yes, go ahead'; // what answerEscalation does
  const env = pxp.buildEnvelope(room, 'A', raw({ status: 'agree' }));
  assert.strictEqual(env.status, 'agree');
  assert.ok(env.accepts);
});

test('an answer to the OTHER seat\'s escalation does not unblock agreement', () => {
  const room = disputedRoom();
  const esc = turn(room, 'B', raw({ status: 'escalate', escalation: { question: 'ok?' } }));
  esc.answer = 'yes';
  assert.strictEqual(pxp.buildEnvelope(room, 'A', raw({ status: 'agree' })).status, 'continue');
});

// ---------- buildEnvelope: shape ----------

test('an unknown status becomes continue and escalation gets a default question', () => {
  const room = mkRoom();
  assert.strictEqual(pxp.buildEnvelope(room, 'A', raw({ status: 'bogus' })).status, 'continue');
  const env = pxp.buildEnvelope(room, 'A', raw({ status: 'escalate' }));
  assert.strictEqual(env.status, 'escalate');
  assert.ok(env.escalation.question.length > 0);
});

test('envelope identifies room, seat and the sealed card hash, and survives garbage input', () => {
  const room = mkRoom();
  const env = pxp.buildEnvelope(room, 'B', null);
  assert.strictEqual(env.room, room.id);
  assert.strictEqual(env.seq, 1);
  assert.strictEqual(env.from.seat, 'B');
  assert.strictEqual(env.intent_hash, room.seats.B.cardHash);
  assert.strictEqual(env.status, 'continue');
  assert.deepStrictEqual(env.claims, []);
});

test('applyEnvelope registers claims and reviews and appends a verifiable ledger entry', () => {
  const room = mkRoom();
  turn(room, 'B', raw({ claims: [{ text: 'a', origin: 'stated', ref: 'x' }, { text: 'b', origin: 'assumed' }] }));
  turn(room, 'A', raw({ reviews: [{ claim_id: 'B1.2', verdict: 'challenge', reason: 'r' }] }));
  assert.strictEqual(room.claims['B1.1'].verified, true);
  assert.strictEqual(room.claims['B1.2'].verified, false);
  assert.strictEqual(room.claims['B1.2'].reviews.length, 1);
  assert.strictEqual(room.claims['B1.2'].reviews[0].by, 'A');
  assert.strictEqual(room.ledger.length, 2);
  assert.strictEqual(pxp.verifyLedger(room.ledger).ok, true);
});

test('normaliseCard always yields a valid-shaped card from junk', () => {
  const c = pxp.normaliseCard('junk', 'Fallback');
  assert.strictEqual(c.principal.name, 'Fallback');
  for (const f of pxp.LIST_FIELDS) assert.ok(Array.isArray(c[f]));
  assert.ok(Array.isArray(c.amendments));
  assert.ok(pxp.validateCard(c).length > 0);
});
