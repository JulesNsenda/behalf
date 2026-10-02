'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { WEB } = require('../test-support/paths');
const { codeOf, assertPure } = require('../test-support/source');
const { JARGON } = require('../test-support/copy');
const AV_PATH = path.join(WEB, 'js', 'agreement-view.js');

// No window here, so both scripts set module.exports. agreement-view reads room-view itself.
assert.strictEqual(typeof globalThis.window, 'undefined');
const AV = require(AV_PATH);
const RV = require(path.join(WEB, 'js', 'room-view.js'));

// ---- hand-built fixtures (no demo text) ----
function claim(id, over) {
  return Object.assign({ id, text: 'Claim ' + id, origin: 'assumed', verified: false, reviews: [], seat: id[0] }, over);
}
function brief(over) {
  return Object.assign({
    outcome: 'agreed',
    agreement: { terms: ['First term', 'Second term'], proposal_hash: 'p'.repeat(64), proposed_by: 'B', proposed_seq: 3, accepted_by: 'A', accepted_seq: 4 },
    authority: [
      { term: 'First term', A: 'must_haves', B: 'may_agree_to', note: 'Matches the list' },
      { term: 'Second term', A: 'amendment', B: 'must_never', note: '' },
    ],
    depends_on: [], unverified_dependencies: [], unverified_in_record: [], challenged: [],
    escalations: [], protocol_flags: [],
    parties: {
      A: { name: 'Lerato Dlamini', card_hash: 'a'.repeat(64), proxy: 'Built-in Claude proxy' },
      B: { name: 'Kwame Mensah', card_hash: 'b'.repeat(64), proxy: 'Claude Desktop' },
    },
    turns: 6, ledger_head: 'h'.repeat(64), ledger_ok: true, generated_at: '2026-10-02T00:00:00Z',
  }, over);
}
function room(over) {
  return Object.assign({
    id: 'r1', topic: 'A topic', status: 'agreed', claims: [], brief: brief(),
    seats: {
      A: { name: 'Lerato Dlamini', mode: 'builtin', agent: null },
      B: { name: 'Kwame Mensah', mode: 'external', agent: 'Claude Desktop' },
    },
    ledgerCheck: { ok: true, head: 'h'.repeat(64) },
  }, over);
}
// A room whose brief is `b`.
function roomOf(b, over) { return room(Object.assign({ brief: b }, over)); }

// ---------- state ----------
test('state: agreed, no-deal, not-yet, not-found', () => {
  assert.strictEqual(AV.state(room()), 'agreed');
  assert.strictEqual(AV.state(room({ brief: brief({ outcome: 'no_agreement', agreement: undefined }) })), 'no-deal');
  assert.strictEqual(AV.state(room({ brief: null })), 'not-yet');
  assert.strictEqual(AV.state(null), 'not-found');
  assert.strictEqual(AV.state(undefined), 'not-found');
});

test('state: an "agreed" brief with no agreement is not trusted as agreed', () => {
  assert.strictEqual(AV.state(room({ brief: brief({ agreement: null }) })), 'no-deal');
});

// ---------- headings ----------
test('heading: with and without the viewer seat', () => {
  assert.strictEqual(AV.heading(room(), 'A'), 'What you and Kwame agreed');
  assert.strictEqual(AV.heading(room(), 'B'), 'What you and Lerato agreed');
  assert.strictEqual(AV.heading(room(), null), 'What Lerato and Kwame agreed');
  assert.strictEqual(AV.heading(room(), undefined), 'What Lerato and Kwame agreed');
  assert.strictEqual(AV.heading(room(), 'Z'), 'What Lerato and Kwame agreed', 'a junk seat is no seat');
  assert.strictEqual(AV.heading(room(), '<b>'), 'What Lerato and Kwame agreed');
});

test('heading: the other states', () => {
  const nodeal = room({ brief: brief({ outcome: 'no_agreement', agreement: undefined }) });
  for (const v of ['A', 'B', null]) {
    assert.strictEqual(AV.heading(nodeal, v), 'No deal reached');
    assert.strictEqual(AV.heading(room({ brief: null }), v), "There's no agreement yet");
    assert.strictEqual(AV.heading(null, v), "We couldn't find this room");
  }
});

test('heading: names come from the brief parties, falling back to the seats', () => {
  const R = room({ brief: brief({ parties: { A: { name: '' }, B: { name: 'Kwame Mensah' } } }) });
  assert.strictEqual(AV.heading(R, null), 'What Lerato and Kwame agreed');
  const none = room({ seats: {}, brief: brief({ parties: {} }) });
  assert.strictEqual(AV.heading(none, null), 'What Seat A and Seat B agreed');
});

test('heading: a name that mimics the viewer\'s labels is replaced, like on the room page', () => {
  const R = room({ brief: brief({ parties: { A: { name: 'You' }, B: { name: 'Kwame Mensah' } } }) });
  assert.strictEqual(AV.heading(R, 'B'), 'What you and Person A agreed');
  assert.strictEqual(AV.heading(R, null), 'What Person A and Kwame agreed');
  const same = room({ brief: brief({ parties: { A: { name: 'Sam Jones' }, B: { name: 'sam Smith' } } }) });
  assert.strictEqual(AV.heading(same, null), 'What Person A and Person B agreed');
  assert.ok(AV.summaryText(R, null).includes('Between Person A and Kwame Mensah'));
});

test('summaryText: the outcome line is the room page\'s outcome, read from the brief', () => {
  const dep = (n) => roomOf(brief({ unverified_dependencies: Array.from({ length: n }, (_, i) => claim('A1.' + (i + 1))) }));
  const outcomeOf = (R, seat) => AV.summaryText(R, seat).split('\n').find(l => /^Deal reached/.test(l));
  assert.strictEqual(outcomeOf(dep(0), 'A'), 'Deal reached. Nothing unconfirmed.');
  assert.strictEqual(outcomeOf(dep(1), 'A'), 'Deal reached, with 1 unconfirmed point');
  assert.strictEqual(outcomeOf(dep(2), null), 'Deal reached, with 2 unconfirmed points');
  for (const n of [0, 1, 3]) {
    const R = dep(n);
    assert.strictEqual(outcomeOf(R, 'A'), RV.outcome({ status: 'agreed', brief: R.brief }).text);
  }
});

// ---------- points ----------
test('points: every authority kind, for the viewer and for the other side', () => {
  const kinds = ['must_haves', 'may_agree_to', 'must_never', 'known_facts', 'amendment', 'none'];
  const expectMe = {
    must_haves: 'One of the things you said the deal must include',
    may_agree_to: 'Something your AI was allowed to agree to',
    must_never: 'Protects something you said must never happen',
    known_facts: 'Rests on something you know for sure',
    amendment: 'Your answer when your AI asked you',
    none: 'Not covered by your instructions',
  };
  const expectThem = {
    must_haves: 'One of the things Kwame said the deal must include',
    may_agree_to: "Something Kwame's AI was allowed to agree to",
    must_never: 'Protects something Kwame said must never happen',
    known_facts: 'Rests on something Kwame knows for sure',
    amendment: "Kwame's answer when their AI asked them",
    none: "Not covered by Kwame's instructions",
  };
  for (const k of kinds) {
    // put `k` on side A and a covered kind on side B so "none" is a single-sided gap
    const b = brief({ agreement: { terms: ['t'] }, authority: [{ term: 't', A: k, B: 'must_haves', note: '' }] });
    const mine = AV.points(roomOf(b), 'A').terms[0].lines.find(l => l.seat === 'A');
    assert.strictEqual(mine.text, expectMe[k], k);
    assert.strictEqual(mine.flagged, k === 'none', k);
    const swapped = brief({ agreement: { terms: ['t'] }, authority: [{ term: 't', A: 'must_haves', B: k, note: '' }] });
    const theirs = AV.points(roomOf(swapped), 'A').terms[0].lines.find(l => l.seat === 'B');
    assert.strictEqual(theirs.text, expectThem[k], k);
    assert.strictEqual(theirs.flagged, k === 'none', k);
    // a spectator sees both names
    const spect = AV.points(roomOf(b), null).terms[0].lines.find(l => l.seat === 'A');
    assert.ok(!/\byou(r)?\b/i.test(spect.text), spect.text);
    assert.ok(spect.text.length > 10);
  }
});

test('points: terms are numbered, carry the model note and a flag when nothing covers them', () => {
  const p = AV.points(room(), 'A');
  assert.strictEqual(p.note, null);
  assert.strictEqual(p.uncovered, 0);
  assert.deepStrictEqual(p.terms.map(t => [t.number, t.term, t.flagged]), [[1, 'First term', false], [2, 'Second term', false]]);
  assert.strictEqual(p.terms[0].note, 'Matches the list');
  assert.strictEqual(p.terms[1].note, null, 'an empty note is no note');
  assert.deepStrictEqual(p.terms[0].lines.map(l => l.seat), ['A', 'B']);
});

test('points: nobody covers a term -> one flagged "anyone\'s instructions" line', () => {
  const b = brief({ authority: [{ term: 'First term', A: 'none', B: 'none', note: 'n' }, { term: 'Second term', A: 'none', B: 'may_agree_to' }] });
  const p = AV.points(roomOf(b), 'A');
  assert.strictEqual(p.uncovered, 2);
  assert.deepStrictEqual(p.terms[0].lines, [{ seat: 'both', kind: 'none', text: "Not covered by anyone's instructions", flagged: true }]);
  assert.strictEqual(p.terms[0].flagged, true);
  assert.strictEqual(p.terms[1].lines[0].text, 'Not covered by your instructions');
  assert.strictEqual(p.terms[1].flagged, true);
});

test('points: unknown authority values are flagged with a fixed sentence and never echoed', () => {
  const b = brief({ authority: [{ term: 't', A: '<script>x</script>', B: undefined }, { term: 't' }] });
  const p = AV.points(roomOf(b), 'A');
  for (const l of p.terms[0].lines) {
    assert.strictEqual(l.text, "We couldn't tell what allowed this.");
    assert.strictEqual(l.flagged, true);
    assert.ok(!JSON.stringify(l).includes('script'));
  }
  assert.strictEqual(p.terms[1].lines.length, 2);
});

test('points: no authority map -> no lines and a single note that follows the viewer', () => {
  for (const authority of [null, undefined]) {
    const R = roomOf(brief({ authority }));
    const p = AV.points(R, 'A');
    assert.strictEqual(p.note, "We couldn't check each point against your instructions.");
    assert.strictEqual(p.terms.length, 2);
    assert.ok(p.terms.every(t => t.lines.length === 0 && !t.flagged && t.note === null));
    assert.strictEqual(p.uncovered, 0);
    assert.strictEqual(AV.points(R, null).note, "We couldn't check each point against their instructions.");
  }
  assert.strictEqual(AV.noAuthorityNote('B'), "We couldn't check each point against your instructions.");
  assert.strictEqual(AV.noAuthorityNote(null), "We couldn't check each point against their instructions.");
  assert.strictEqual(AV.noAuthorityNote('Z'), "We couldn't check each point against their instructions.");
});

test('points: a short authority map leaves the extra terms without lines', () => {
  const p = AV.points(roomOf(brief({ authority: [{ term: 'First term', A: 'must_haves', B: 'must_haves' }] })), 'A');
  assert.strictEqual(p.terms[0].lines.length, 2);
  assert.strictEqual(p.terms[1].lines.length, 0);
  assert.strictEqual(p.note, null);
});

test('points: no terms and a missing brief are empty, not errors', () => {
  assert.deepStrictEqual(AV.points(roomOf(brief({ agreement: undefined })), 'A').terms, []);
  assert.deepStrictEqual(AV.points(room({ brief: null }), 'A').terms, []);
  assert.deepStrictEqual(AV.points(null, 'A').terms, []);
});

// ---------- guesses ----------
test('guessesOnRecord: only unconfirmed claims the deal does not rely on', () => {
  const relied = claim('A1.1', { text: 'Relied on' });
  const spare = claim('B2.1', { text: 'Spare guess', reviews: [{ by: 'A', verdict: 'challenge', reason: 'Not sure', seq: 3 }, { by: 'B', verdict: 'accept', reason: '', seq: 4 }] });
  const R = roomOf(brief({ unverified_dependencies: [relied], unverified_in_record: [relied, spare] }));
  const g = AV.guessesOnRecord(R, 'A');
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].text, 'Spare guess');
  assert.strictEqual(g[0].by, "Kwame's AI");
  assert.strictEqual(g[0].note, "Not confirmed. Kwame's AI guessed this.");
  assert.deepStrictEqual(g[0].reviews, [{ sentence: 'Your AI couldn\'t confirm this', reason: 'Not sure' }]);
  assert.strictEqual(AV.guessesOnRecord(R, 'B')[0].by, 'Your AI');
  assert.strictEqual(AV.guessesOnRecord(R, null)[0].reviews[0].sentence, "Lerato's AI couldn't confirm this");
});

test('guessesOnRecord: conflicts read as disagreement; empty and missing are empty', () => {
  const c = claim('A1.1', { reviews: [{ by: 'B', verdict: 'conflict', reason: 'r' }] });
  assert.strictEqual(AV.guessesOnRecord(roomOf(brief({ unverified_in_record: [c] })), 'A')[0].reviews[0].sentence, "Kwame's AI disagrees with this");
  assert.deepStrictEqual(AV.guessesOnRecord(room(), 'A'), []);
  assert.deepStrictEqual(AV.guessesOnRecord(null, 'A'), []);
});

// ---------- escalations ----------
test('escalations: asked and answered, relayed, unanswered', () => {
  const R = roomOf(brief({ escalations: [
    { seat: 'A', principal: 'Lerato Dlamini', question: 'Is it ok?', answer: 'No', via: 'web' },
    { seat: 'B', principal: 'Kwame Mensah', question: 'And this?', answer: 'Yes', via: 'mcp' },
    { seat: 'B', principal: 'Kwame Mensah', question: 'Open?', answer: null, via: null },
  ] }));
  const e = AV.escalations(R, 'A');
  assert.deepStrictEqual(e[0], { asked: 'Your AI asked you:', question: 'Is it ok?', answered: 'You answered:', answer: 'No' });
  assert.deepStrictEqual(e[1], { asked: "Kwame's AI asked Kwame:", question: 'And this?', answered: 'Kwame answered (through their agent):', answer: 'Yes' });
  assert.deepStrictEqual(e[2], { asked: "Kwame's AI asked Kwame:", question: 'Open?', answered: "Kwame didn't answer.", answer: '' });
  assert.strictEqual(AV.escalations(R, 'B')[1].answered, 'You answered (through your agent):');
  assert.strictEqual(AV.escalations(R, 'B')[2].answered, "You didn't answer.");
  assert.strictEqual(AV.escalations(R, null)[0].asked, "Lerato's AI asked Lerato:");
  assert.deepStrictEqual(AV.escalations(room(), 'A'), []);
});

// ---------- flags ----------
test('flags: the room page\'s sentences, never the raw flag', () => {
  const raw = 'Proxy tried to agree while flagging a conflict; agreement withheld.';
  const R = roomOf(brief({ protocol_flags: [{ seq: 4, seat: 'A', flag: raw }, { seq: 5, seat: 'B', flag: 'Some new unmatched rule text' }] }));
  const out = AV.flags(R);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0], RV.flagSentence(raw));
  assert.strictEqual(out[1].sentence, RV.FLAG_FALLBACK);
  assert.ok(!JSON.stringify(out).includes(raw));
  assert.ok(!JSON.stringify(out).includes('unmatched'));
  assert.strictEqual(AV.FLAG_FALLBACK, undefined, 'the fallback has one home');
});

test('flags: quoted detail passes through; none and a missing room are empty', () => {
  const quoted = 'Claim "The thing" was tagged stated without a reference; downgraded to assumed.';
  assert.strictEqual(AV.flags(roomOf(brief({ protocol_flags: [{ seq: 1, seat: 'A', flag: quoted }] })))[0].detail, 'The thing');
  assert.deepStrictEqual(AV.flags(room()), []);
  assert.deepStrictEqual(AV.flags(null), []);
});

// ---------- AI labels and details ----------
test('aiLabel: "Our AI" for a built-in seat, the agent\'s name for its own agent', () => {
  const R = room();
  assert.strictEqual(AV.aiLabel(R, 'A'), 'Our AI');
  assert.strictEqual(AV.aiLabel(R, 'B'), 'Claude Desktop (their own agent)');
  const ext = (seat) => room({ seats: { A: Object.assign({ name: 'L', mode: 'external' }, seat), B: { name: 'K', mode: 'builtin' } } });
  assert.strictEqual(AV.aiLabel(ext({ agent: '  Padded  ' }), 'A'), 'Padded (their own agent)');
  assert.strictEqual(AV.aiLabel(ext({ agent: null }), 'A'), 'Their own agent');
  assert.strictEqual(AV.aiLabel(ext({ agent: '   ' }), 'A'), 'Their own agent');
  assert.strictEqual(AV.aiLabel(ext({}), 'A'), 'Their own agent');
  assert.strictEqual(AV.aiLabel(null, 'A'), 'Their own agent');
});

test('aiLabel: the seat\'s mode decides, never the text of a label', () => {
  // a built-in seat is "Our AI" even if its recorded label looks like an agent's
  const b = brief({ parties: { A: { name: 'L', proxy: 'Claude Desktop' }, B: { name: 'K', proxy: 'Built-in Claude proxy' } } });
  const R = roomOf(b, { seats: { A: { name: 'L', mode: 'builtin' }, B: { name: 'K', mode: 'external', agent: 'My Agent' } } });
  assert.strictEqual(AV.aiLabel(R, 'A'), 'Our AI');
  assert.strictEqual(AV.aiLabel(R, 'B'), 'My Agent (their own agent)');
});

test('detailRows: labels, hashes and the record check', () => {
  const d = AV.detailRows(room(), null);
  assert.deepStrictEqual(d.rows.map(r => r.label), ["Lerato's AI", "Kwame's AI", "Lerato's instructions", "Kwame's instructions", 'Agreement', 'Record']);
  assert.deepStrictEqual(d.rows.map(r => r.mono), [false, false, true, true, true, true]);
  assert.strictEqual(d.rows[0].value, 'Our AI');
  assert.strictEqual(d.rows[1].value, 'Claude Desktop (their own agent)');
  assert.strictEqual(d.recordLabel, 'Record checks out');
  assert.strictEqual(d.recordOk, true);
  const mine = AV.detailRows(room(), 'A');
  assert.deepStrictEqual(mine.rows.map(r => r.label).slice(0, 4), ['Your AI', "Kwame's AI", 'Your instructions', "Kwame's instructions"]);
  const lean = AV.detailRows(roomOf(brief({ agreement: undefined, ledger_head: '', parties: { A: { name: 'L' }, B: { name: 'K' } } }), { seats: {} }), null);
  assert.deepStrictEqual(lean.rows.map(r => r.label), ["L's AI", "K's AI"]);
  assert.deepStrictEqual(AV.detailRows(null, null).rows.map(r => r.label), ["Seat A's AI", "Seat B's AI"]);
});

test('detailRows: the live record check wins; the brief\'s copy is only a fallback', () => {
  const bad = AV.detailRows(room({ ledgerCheck: { ok: false, brokenAt: 3 } }), 'A');
  assert.strictEqual(bad.recordOk, false);
  assert.strictEqual(bad.recordLabel, 'Record was changed');
  // the brief says fine but the live check failed
  assert.strictEqual(AV.detailRows(roomOf(brief({ ledger_ok: true }), { ledgerCheck: { ok: false } }), 'A').recordOk, false);
  // the brief says broken but the live check passed
  const fixed = AV.detailRows(roomOf(brief({ ledger_ok: false }), { ledgerCheck: { ok: true } }), 'A');
  assert.strictEqual(fixed.recordOk, true);
  assert.strictEqual(fixed.recordLabel, 'Record checks out');
  // no live check: fall back to the brief
  for (const ledgerCheck of [undefined, null, {}, { ok: 'yes' }]) {
    assert.strictEqual(AV.detailRows(roomOf(brief({ ledger_ok: true }), { ledgerCheck }), 'A').recordOk, true);
    assert.strictEqual(AV.detailRows(roomOf(brief({ ledger_ok: false }), { ledgerCheck }), 'A').recordOk, false);
  }
  assert.strictEqual(AV.detailRows(roomOf(brief({ ledger_ok: undefined }), { ledgerCheck: undefined }), 'A').recordLabel, RV.recordStatus(false));
});

// ---------- no deal ----------
test('noDeal: what was claimed, and where they got stuck', () => {
  const challenged = claim('B1.1', { text: 'Stuck here', reviews: [{ by: 'A', verdict: 'conflict', reason: 'It is wrong' }, { by: 'B', verdict: 'accept', reason: '' }] });
  const R = room({
    claims: [claim('A1.1', { text: 'Mine', origin: 'stated', verified: true }), challenged],
    brief: brief({ outcome: 'no_agreement', agreement: undefined, challenged: [challenged] }),
  });
  const nd = AV.noDeal(R, 'A');
  assert.deepStrictEqual(nd.claimed, [
    { by: 'Your AI', text: 'Mine', confirmed: true },
    { by: "Kwame's AI", text: 'Stuck here', confirmed: false },
  ]);
  assert.deepStrictEqual(nd.stuck, [{ by: "Kwame's AI", text: 'Stuck here', reviews: [{ sentence: 'Your AI disagrees with this', reason: 'It is wrong' }] }]);
  assert.strictEqual(AV.noDeal(R, null).claimed[0].by, "Lerato's AI");
  assert.deepStrictEqual(AV.noDeal(null, 'A'), { claimed: [], stuck: [] });
});

// ---------- summary ----------
const URL_RE = /https?:|:\/\/|www\.|\/room\/|\/brief\/|[?&]t=|[?&]seat=|\blocalhost\b/i;

test('summaryText: an agreed deal as plain text with no URLs, under the neutral heading', () => {
  const dep = claim('A1.1', { text: 'It never retries' });
  const R = roomOf(brief({
    unverified_dependencies: [dep],
    escalations: [{ seat: 'A', principal: 'Lerato Dlamini', question: 'Is it ok?', answer: 'No', via: 'web' }],
    protocol_flags: [{ seq: 2, seat: 'A', flag: 'Proxy agreed but there was no proposal from the other side; treated as continue.' }],
  }));
  const t = AV.summaryText(R, 'A');
  assert.strictEqual(typeof t, 'string');
  // a copied summary is read by someone else, so its heading never says "you"
  assert.ok(t.startsWith('What Lerato and Kwame agreed\n'), t);
  assert.strictEqual(AV.summaryText(R, null).split('\n')[0], 'What Lerato and Kwame agreed');
  assert.strictEqual(AV.summaryText(R, 'B').split('\n')[0], 'What Lerato and Kwame agreed');
  assert.notStrictEqual(AV.heading(R, 'A'), AV.summaryText(R, 'A').split('\n')[0], 'the page heading is still viewer-aware');
  assert.ok(t.includes('Between Lerato Dlamini and Kwame Mensah'));
  assert.ok(t.includes('Deal reached, with 1 unconfirmed point'));
  assert.ok(t.includes('1. First term') && t.includes('2. Second term'));
  assert.ok(t.includes('Relies on points nobody confirmed:\n- It never retries'));
  assert.ok(t.includes('Your AI asked you: Is it ok?'));
  assert.ok(t.includes('You answered: No'));
  assert.ok(t.includes('The room stopped these:'));
  assert.ok(!URL_RE.test(t), t);
  assert.ok(!/<|>/.test(t));
  assert.ok(!t.includes('h'.repeat(64)) && !t.includes('a'.repeat(64)), 'no hashes');
});

test('summaryText: spectator wording, gaps and no authority map', () => {
  const gap = roomOf(brief({ authority: [{ term: 'x', A: 'none', B: 'none' }, { term: 'y', A: 'must_haves', B: 'must_haves' }] }));
  const t = AV.summaryText(gap, null);
  assert.ok(t.startsWith('What Lerato and Kwame agreed\n'));
  assert.ok(t.includes('Deal reached. Nothing unconfirmed.'));
  assert.ok(t.includes('1. First term (not covered by the instructions)'));
  assert.ok(!t.includes('2. Second term (not'));
  const none = roomOf(brief({ authority: null }));
  assert.ok(AV.summaryText(none, 'A').includes("We couldn't check each point against your instructions."));
  assert.ok(AV.summaryText(none, null).includes("We couldn't check each point against their instructions."));
  assert.ok(!AV.summaryText(none, 'A').includes('Relies on'));
});

test('summaryText: no deal, not yet and not found', () => {
  const stuck = claim('B1.1', { text: 'Stuck point' });
  const nodeal = room({ brief: brief({ outcome: 'no_agreement', agreement: undefined, challenged: [stuck] }), claims: [stuck] });
  const t = AV.summaryText(nodeal, 'A');
  assert.ok(t.startsWith('No deal reached\n'));
  assert.ok(t.includes('No deal was reached.'));
  assert.ok(t.includes('Where they got stuck:\n- Stuck point'));
  assert.ok(!t.includes('1. First term'));
  assert.strictEqual(AV.summaryText(room({ brief: null }), 'A'), "There's no agreement yet\nTopic: A topic");
  assert.strictEqual(AV.summaryText(room({ brief: null, topic: '' }), 'A'), "There's no agreement yet");
  assert.strictEqual(AV.summaryText(null, 'A'), "We couldn't find this room");
});

test('summaryText: never includes the raw flag text, tokens or links the room carried', () => {
  const raw = 'Brand new unmatched rule text with https://evil.example/?t=SECRET';
  const R = roomOf(brief({ protocol_flags: [{ seq: 1, seat: 'A', flag: raw }] }));
  const t = AV.summaryText(R, 'A');
  assert.ok(!t.includes('evil.example') && !t.includes('SECRET'));
  assert.ok(t.includes(RV.FLAG_FALLBACK));
  assert.ok(!URL_RE.test(t));
});

// ---------- one source of wording ----------
test('agreement-view reads room-view for shared wording and keeps no copies', () => {
  const code = codeOf(AV_PATH);
  // no copy of the room page's sentences
  for (const phrase of ["couldn't confirm this", 'disagrees with this', 'guessed this', 'Deal reached', 'Record checks out', 'Record was changed',
    'The room stopped an AI move', 'Built-in Claude proxy']) {
    assert.ok(!code.includes(phrase), phrase);
  }
  assert.ok(/window\.RoomView/.test(code) && /require\('\.\/room-view\.js'\)/.test(code));
  // deferred scripts run in document order, so every page that loads both must list room-view first
  for (const page of fs.readdirSync(WEB).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(WEB, page), 'utf8');
    const a = html.indexOf('agreement-view.js');
    if (a < 0) continue;
    const r = html.indexOf('room-view.js');
    assert.ok(r >= 0 && r < a, `${page} loads room-view.js before agreement-view.js`);
  }
});

// ---------- purity ----------
test('agreement-view is pure: no DOM, UI, markup, storage or regex constructor', () => {
  assertPure(codeOf(AV_PATH), { allowRequire: true });
});

test('reader-facing strings avoid protocol jargon', () => {
  const R = roomOf(brief({ escalations: [{ seat: 'A', principal: 'L', question: 'q', answer: 'a', via: 'mcp' }], unverified_dependencies: [claim('A1.1')] }));
  const strings = [
    AV.heading(R, 'A'), AV.heading(R, null), RV.outcome({ status: 'agreed', brief: R.brief }).text, AV.noAuthorityNote('A'), AV.noAuthorityNote(null),
    ...AV.points(R, 'A').terms.flatMap(t => t.lines.map(l => l.text)),
    ...AV.points(roomOf(brief({ authority: [{ A: 'none', B: 'none' }, { A: 'x', B: 'y' }] })), 'A').terms.flatMap(t => t.lines.map(l => l.text)),
    ...AV.escalations(R, 'A').flatMap(e => [e.asked, e.answered]),
    AV.aiLabel(R, 'A'), AV.aiLabel(R, 'B'), AV.detailRows(R, 'A').recordLabel,
  ];
  for (const s of strings) assert.ok(!JARGON.test(s), s);
});

test('summaryText: an agreed summary includes the topic, and omits the line when there is none', () => {
  assert.ok(AV.summaryText(roomOf(brief({})), 'A').includes('Topic: A topic'));
  assert.ok(!AV.summaryText(roomOf(brief({}), { topic: '' }), 'A').includes('Topic:'));
});
