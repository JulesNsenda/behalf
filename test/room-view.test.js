'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { WEB, readRepo } = require('../test-support/paths');
const { codeOf, assertPure } = require('../test-support/source');
const { JARGON } = require('../test-support/copy');
const pxp = require('../lib/pxp');

const RV_PATH = path.join(WEB, 'js', 'room-view.js');
// No window here, so room-view.js sets module.exports.
assert.strictEqual(typeof globalThis.window, 'undefined');
const RV = require(RV_PATH);

// ---- hand-built view fixtures (no demo text) ----
function seat(name, over) {
  return Object.assign({ name, role: '', sealed: false, cardHash: null, drafted: false, mode: 'builtin', agent: null, sealedVia: null }, over);
}
function view(over) {
  return Object.assign({
    id: 'r1', topic: 'A topic', demo: false, status: 'drafting', seat: null,
    seats: { A: seat('Lerato Dlamini'), B: seat('Kwame Mensah') },
    envelopes: [], claims: [], turn: 'A', turnCount: 0, maxTurns: 12,
    pending: null, error: null, brief: null, interrupted: false, ledger: [], thinking: null, waitingOn: null,
  }, over);
}
const sealed = { sealed: true };

// ---------- step ----------
test('step: not found when the room is null', () => {
  assert.strictEqual(RV.step(null, {}).key, 'not-found');
  assert.strictEqual(RV.step(null).key, 'not-found');
});

test('step: every key it can return is a declared step', () => {
  const seen = new Set();
  for (const status of ['drafting', 'negotiating', 'paused', 'agreed', 'stalled', 'error']) {
    for (const seatId of [null, 'A', 'B']) {
      for (const demo of [false, true]) {
        for (const hadCredentials of [false, true]) {
          for (const previewSeat of [null, 'B']) {
            for (const welcomeSeen of [false, true]) {
              for (const demoStarted of [false, true]) {
                for (const locked of [false, true]) {
                  const seats = { A: seat('Lerato Dlamini', { sealed: locked }), B: seat('Kwame Mensah', { sealed: locked }) };
                  const k = RV.step(view({ status, seat: seatId, demo, seats }), { hadCredentials, previewSeat, welcomeSeen, demoStarted }).key;
                  assert.ok(RV.STEPS.includes(k), k);
                  seen.add(k);
                }
              }
            }
          }
        }
      }
    }
  }
  for (const k of ['invalid-link', 'preview', 'welcome', 'instructions', 'ready', 'conversation', 'spectator-drafting', 'demo-intro']) {
    assert.ok(seen.has(k), `${k} is reachable`);
  }
});

test('step: invalid link (credentials in the URL, no confirmed seat)', () => {
  const s = RV.step(view(), { hadCredentials: true });
  assert.strictEqual(s.key, 'invalid-link');
  assert.strictEqual(s.readOnly, true);
  assert.strictEqual(s.then, 'spectator-drafting');
  assert.strictEqual(RV.step(view({ status: 'negotiating' }), { hadCredentials: true }).then, 'conversation');
});

test('step: bad token behaves like a missing seat, whatever the URL said', () => {
  // The server confirms seats. A URL that says seat=A with a wrong token arrives as R.seat === null.
  const s = RV.step(view({ seat: null }), { hadCredentials: true, welcomeSeen: true, previewSeat: 'B' });
  assert.strictEqual(s.key, 'invalid-link');
  assert.notStrictEqual(s.key, 'instructions');
});

test('step: no credentials in the URL and no seat is a spectator, not an invalid link', () => {
  assert.strictEqual(RV.step(view(), { hadCredentials: false }).key, 'spectator-drafting');
  const s = RV.step(view({ status: 'negotiating' }), {});
  assert.strictEqual(s.key, 'conversation');
  assert.strictEqual(s.readOnly, true);
});

test('step: a demo room never shows the invalid-link step', () => {
  assert.strictEqual(RV.step(view({ demo: true }), { hadCredentials: true }).key, 'spectator-drafting');
});

test('step: preview only while the previewed seat has not locked, and only without a seat', () => {
  assert.strictEqual(RV.step(view(), { previewSeat: 'B' }).key, 'preview');
  assert.strictEqual(RV.step(view(), { previewSeat: 'B' }).readOnly, true);
  assert.strictEqual(RV.step(view(), { previewSeat: 'C' }).key, 'spectator-drafting');
  assert.strictEqual(RV.step(view(), { previewSeat: 'A' }).key, 'spectator-drafting', 'only the invited person is previewed');
  assert.strictEqual(RV.step(view({ seats: { A: seat('L'), B: seat('K', sealed) } }), { previewSeat: 'B' }).key, 'spectator-drafting');
  assert.strictEqual(RV.step(view({ status: 'negotiating' }), { previewSeat: 'B' }).key, 'conversation');
  // a confirmed seat wins over the preview parameter
  assert.strictEqual(RV.step(view({ seat: 'A' }), { previewSeat: 'B' }).key, 'instructions');
  assert.strictEqual(RV.step(view({ demo: true }), { previewSeat: 'B' }).key, 'spectator-drafting');
});

test('step: seat B sees the welcome first, then instructions once seen', () => {
  assert.strictEqual(RV.step(view({ seat: 'B' }), { welcomeSeen: false }).key, 'welcome');
  assert.strictEqual(RV.step(view({ seat: 'B' }), { welcomeSeen: true }).key, 'instructions');
});

test('step: seat A skips the welcome', () => {
  assert.strictEqual(RV.step(view({ seat: 'A' }), { welcomeSeen: false }).key, 'instructions');
});

test('step: a locked seat is ready, even if the welcome was never seen', () => {
  const R = view({ seat: 'B', seats: { A: seat('L'), B: seat('K', sealed) } });
  assert.strictEqual(RV.step(R, { welcomeSeen: false }).key, 'ready');
  const A = view({ seat: 'A', seats: { A: seat('L', sealed), B: seat('K') } });
  assert.strictEqual(RV.step(A, {}).key, 'ready');
});

test('step: demo rooms skip the welcome and show the intro until started', () => {
  const R = view({ demo: true, seat: 'A' });
  assert.strictEqual(RV.step(R, { welcomeSeen: false, demoStarted: false }).key, 'demo-intro');
  assert.strictEqual(RV.step(view({ demo: true, seat: 'B' }), {}).key, 'demo-intro');
  assert.strictEqual(RV.step(R, { demoStarted: true }).key, 'conversation');
  assert.strictEqual(RV.step(view({ demo: true, seat: null }), {}).key, 'spectator-drafting');
});

test('step: a demo goes to the conversation once the viewer\'s seat or both seats are locked, whatever demoStarted says', () => {
  const both = { A: seat('L', sealed), B: seat('K', sealed) };
  const onlyA = { A: seat('L', sealed), B: seat('K') };
  for (const demoStarted of [false, true, undefined]) {
    assert.strictEqual(RV.step(view({ demo: true, seat: 'A', seats: both }), { demoStarted }).key, 'conversation');
    assert.strictEqual(RV.step(view({ demo: true, seat: 'B', seats: both }), { demoStarted }).key, 'conversation');
    assert.strictEqual(RV.step(view({ demo: true, seat: 'A', seats: onlyA }), { demoStarted }).key, 'conversation');
  }
  assert.strictEqual(RV.step(view({ demo: true, seat: 'B', seats: onlyA }), {}).key, 'demo-intro');
});

test('step: once the room is under way every seat holder gets the conversation', () => {
  for (const status of ['negotiating', 'paused', 'agreed', 'stalled', 'error']) {
    for (const seatId of ['A', 'B', null]) {
      const s = RV.step(view({ status, seat: seatId }), {});
      assert.strictEqual(s.key, 'conversation');
      assert.strictEqual(s.readOnly, !seatId);
    }
  }
});

test('step: connectCallout for the viewer\'s own external seat with no agent, until the room is done', () => {
  const ext = (agent) => ({ A: seat('L', { mode: 'external', agent }), B: seat('K') });
  const mk = (status, agent, over) => view(Object.assign({ status, seat: 'A', seats: ext(agent) }, over));
  assert.strictEqual(RV.step(mk('negotiating', null), {}).connectCallout, true);
  assert.strictEqual(RV.step(mk('paused', null), {}).connectCallout, true);
  assert.strictEqual(RV.step(mk('error', null), {}).connectCallout, true);
  assert.strictEqual(RV.step(mk('negotiating', 'Claude'), {}).connectCallout, false, 'agent attached');
  assert.strictEqual(RV.step(mk('agreed', null), {}).connectCallout, false, 'finished');
  assert.strictEqual(RV.step(mk('stalled', null), {}).connectCallout, false, 'finished');
  assert.strictEqual(RV.step(mk('negotiating', null, { seat: 'B' }), {}).connectCallout, false, 'other seat is the external one');
  assert.strictEqual(RV.step(mk('negotiating', null, { seat: null }), {}).connectCallout, false, 'spectator');
  assert.strictEqual(RV.step(mk('negotiating', null, { demo: true }), {}).connectCallout, false, 'demo');
  assert.strictEqual(RV.step(view({ status: 'negotiating', seat: 'A' }), {}).connectCallout, false, 'built-in seat');
});

test('step: identity comes from R.seat only, never from the URL context', () => {
  // ctx has no seat field and a URL "seat=A" cannot be passed in. A confirmed B stays B.
  const R = view({ seat: 'B' });
  assert.strictEqual(RV.step(R, { hadCredentials: true, previewSeat: 'A' }).key, 'welcome');
});

// ---------- status ----------
const LABELS = [
  /^Getting ready$/, /^Talking$/, /^Waiting for you$/, /^Waiting for \S+ to answer their AI$/,
  /^Waiting for (\S+'s|your) agent$/, /^Waiting for (\S+'s|your) agent to connect$/,
  /^Paused$/, /^Deal reached$/, /^No deal$/, /^Something went wrong$/,
];
const TONES = ['info', 'ok', 'warn', 'danger'];

test('status: exact labels for each situation', () => {
  const ext = (agent) => ({ A: seat('Lerato Dlamini'), B: seat('Kwame Mensah', { mode: 'external', agent }) });
  const cases = [
    [view({ status: 'drafting' }), 'Getting ready'],
    [view({ status: 'negotiating', thinking: 'A' }), 'Talking'],
    [view({ status: 'negotiating' }), 'Talking'],
    [view({ status: 'paused', seat: 'A', pending: { seat: 'A', seq: 2 } }), 'Waiting for you'],
    [view({ status: 'paused', seat: 'A', pending: { seat: 'B', seq: 2 } }), 'Waiting for Kwame to answer their AI'],
    [view({ status: 'paused', seat: null, pending: { seat: 'A', seq: 2 } }), 'Waiting for Lerato to answer their AI'],
    [view({ status: 'paused', seat: 'B', demo: true, pending: { seat: 'A', seq: 2 } }), 'Waiting for you'],
    [view({ status: 'negotiating', seat: 'A', waitingOn: 'B', seats: ext('Claude') }), "Waiting for Kwame's agent"],
    [view({ status: 'negotiating', seat: 'A', waitingOn: 'B', seats: ext(null) }), "Waiting for Kwame's agent to connect"],
    [view({ status: 'negotiating', seat: 'B', waitingOn: 'B', seats: ext('Claude') }), 'Waiting for your agent'],
    [view({ status: 'negotiating', seat: 'B', waitingOn: 'B', seats: ext(null) }), 'Waiting for your agent to connect'],
    [view({ status: 'negotiating', seat: null, waitingOn: 'B', seats: ext(null) }), "Waiting for Kwame's agent to connect"],
    [view({ status: 'paused' }), 'Paused'],
    [view({ status: 'paused', interrupted: true }), 'Something went wrong'],
    [view({ status: 'paused', interrupted: true, seat: 'A', pending: { seat: 'A', seq: 2 } }), 'Waiting for you'],
    [view({ status: 'agreed' }), 'Deal reached'],
    [view({ status: 'stalled' }), 'No deal'],
    [view({ status: 'error' }), 'Something went wrong'],
  ];
  for (const [R, label] of cases) assert.strictEqual(RV.status(R).label, label, JSON.stringify([R.status, R.seat, R.waitingOn, R.pending]));
});

test('status: "to connect" only when no agent is attached', () => {
  const R = (agent) => view({ status: 'negotiating', seat: 'A', waitingOn: 'B', seats: { A: seat('L'), B: seat('Kwame', { mode: 'external', agent }) } });
  assert.ok(!/to connect/.test(RV.status(R('Claude')).label));
  assert.ok(/to connect$/.test(RV.status(R(null)).label));
  assert.strictEqual(RV.status(R(null)).tone, 'warn');
  assert.strictEqual(RV.status(R('Claude')).tone, 'info');
});

test('status: total over every combination of its inputs, always a plan label and a known tone', () => {
  const statuses = ['drafting', 'negotiating', 'paused', 'agreed', 'stalled', 'error', 'weird', undefined, null, ''];
  for (const status of statuses) for (const pending of [null, { seat: 'A', seq: 1 }, { seat: 'B', seq: 1 }, { seat: 'Z', seq: 1 }])
    for (const interrupted of [false, true]) for (const waitingOn of [null, 'A', 'B', 'Z'])
      for (const agent of [null, 'Claude']) for (const seatId of [null, 'A', 'B']) for (const demo of [false, true]) {
        const R = view({ status, pending, interrupted, waitingOn, seat: seatId, demo, seats: { A: seat('Lerato', { agent }), B: seat('Kwame', { agent }) } });
        const r = RV.status(R);
        assert.ok(TONES.includes(r.tone), r.tone);
        assert.ok(LABELS.some(re => re.test(r.label)), `${r.label} for ${JSON.stringify([status, pending, waitingOn, seatId, demo])}`);
      }
  assert.ok(LABELS.some(re => re.test(RV.status(null).label)));
  assert.ok(LABELS.some(re => re.test(RV.status(undefined).label)));
});

test('status: interrupted matters, and only for a paused room with nobody to answer', () => {
  for (const pending of [null, { seat: 'A', seq: 1 }, { seat: 'B', seq: 1 }]) {
    for (const seatId of [null, 'A', 'B']) {
      for (const status of ['drafting', 'negotiating', 'paused', 'agreed', 'stalled', 'error']) {
        const mk = (interrupted) => RV.status(view({ status, pending, seat: seatId, interrupted }));
        const differs = mk(true).label !== mk(false).label || mk(true).tone !== mk(false).tone;
        assert.strictEqual(differs, status === 'paused' && !pending, JSON.stringify([status, pending, seatId]));
      }
    }
  }
  assert.deepStrictEqual(RV.status(view({ status: 'paused', interrupted: true })), { label: 'Something went wrong', tone: 'danger' });
});

test('status: tones', () => {
  assert.strictEqual(RV.status(view({ status: 'agreed' })).tone, 'ok');
  assert.strictEqual(RV.status(view({ status: 'error' })).tone, 'danger');
  assert.strictEqual(RV.status(view({ status: 'stalled' })).tone, 'warn');
  assert.strictEqual(RV.status(view({ status: 'drafting' })).tone, 'info');
});

test('canAnswer / waitingEvent / problem', () => {
  const p = { seat: 'A', seq: 3 };
  assert.strictEqual(RV.canAnswer(view({ seat: 'A', pending: p })), true);
  assert.strictEqual(RV.canAnswer(view({ seat: 'B', pending: p })), false);
  assert.strictEqual(RV.canAnswer(view({ seat: 'B', pending: p, demo: true })), true);
  assert.strictEqual(RV.canAnswer(view({ seat: null, pending: p, demo: true })), false);
  assert.strictEqual(RV.canAnswer(view({ seat: 'A' })), false);
  assert.strictEqual(RV.waitingEvent(view({ seat: 'B', pending: p })), 'Waiting for Lerato to answer their AI');
  assert.strictEqual(RV.waitingEvent(view({ seat: 'A', pending: p })), null);
  assert.strictEqual(RV.waitingEvent(view({ seat: 'A' })), null);
  // R.turn is whose turn it was when it failed, read relative to the viewer
  assert.deepStrictEqual(RV.problem(view({ status: 'error', seat: 'A', turn: 'A' })), { text: 'Your AI hit a problem.', canResume: true });
  assert.deepStrictEqual(RV.problem(view({ status: 'error', seat: 'A', turn: 'B' })), { text: "Kwame's AI hit a problem.", canResume: true });
  assert.deepStrictEqual(RV.problem(view({ status: 'paused', interrupted: true, seat: 'B', turn: 'B' })), { text: 'Your AI hit a problem.', canResume: true });
  assert.deepStrictEqual(RV.problem(view({ status: 'paused', interrupted: true, seat: 'B', turn: 'A' })), { text: "Lerato's AI hit a problem.", canResume: true });
  assert.deepStrictEqual(RV.problem(view({ status: 'error', turn: 'A' })), { text: 'An AI hit a problem.', canResume: false });
  assert.deepStrictEqual(RV.problem(view({ status: 'error', seat: 'A', turn: null })), { text: 'An AI hit a problem.', canResume: true });
  assert.strictEqual(RV.problem(view({ status: 'paused', interrupted: true, pending: p })), null);
  assert.strictEqual(RV.problem(view({ status: 'negotiating' })), null);
  assert.strictEqual(RV.problem(null), null);
});

// ---------- guesses and outcome ----------
test('guessCount: before an agreement counts every unconfirmed claim', () => {
  const claims = [{ id: 'A1.1', verified: false }, { id: 'A1.2', verified: true }, { id: 'B2.1', verified: false }];
  assert.strictEqual(RV.guessCount(view({ status: 'negotiating', claims })), 2);
  assert.strictEqual(RV.guessCount(view({ status: 'negotiating', claims: [] })), 0);
  assert.strictEqual(RV.guessCount(null), 0);
});

test('guessCount: after an agreement counts brief.unverified_dependencies only', () => {
  const claims = [{ id: 'A1.1', verified: false }, { id: 'B2.1', verified: false }, { id: 'B2.2', verified: false }];
  const brief = { unverified_dependencies: [{ id: 'A1.1' }], unverified_in_record: claims };
  assert.strictEqual(RV.guessCount(view({ status: 'agreed', claims, brief })), 1);
  assert.strictEqual(RV.guessCount(view({ status: 'agreed', claims, brief: { unverified_dependencies: [] } })), 0);
  assert.strictEqual(RV.guessCount(view({ status: 'agreed', claims, brief: {} })), 0);
});

test('guessPill and outcome wording', () => {
  assert.strictEqual(RV.guessPill(view({ claims: [] })), null);
  assert.strictEqual(RV.guessPill(view({ claims: [{ id: 'A1.1', verified: false }] })), '1 guess not confirmed');
  assert.strictEqual(RV.guessPill(view({ claims: [{ verified: false }, { verified: false }] })), '2 guesses not confirmed');
  const dep = (n) => ({ unverified_dependencies: Array.from({ length: n }, (_, i) => ({ id: 'A1.' + i })) });
  assert.deepStrictEqual(RV.outcome(view({ status: 'agreed', brief: dep(0) })), { tone: 'ok', text: 'Deal reached. Nothing unconfirmed.' });
  assert.deepStrictEqual(RV.outcome(view({ status: 'agreed', brief: dep(1) })), { tone: 'warn', text: 'Deal reached, with 1 unconfirmed point' });
  assert.deepStrictEqual(RV.outcome(view({ status: 'agreed', brief: dep(3) })), { tone: 'warn', text: 'Deal reached, with 3 unconfirmed points' });
  assert.deepStrictEqual(RV.outcome(view({ status: 'stalled' })), { tone: 'warn', text: 'No deal' });
  assert.strictEqual(RV.outcome(view({ status: 'negotiating' })), null);
  assert.strictEqual(RV.outcome(null), null);
});

// ---------- names ----------
test('names: the viewer is "You" / "Your AI" and others use the first name', () => {
  const R = view({ seat: 'A' });
  assert.strictEqual(RV.firstName(R, 'A'), 'Lerato');
  assert.strictEqual(RV.firstName(R, 'B'), 'Kwame');
  assert.strictEqual(RV.aiName(R, 'A'), 'Your AI');
  assert.strictEqual(RV.aiName(R, 'B'), "Kwame's AI");
  const B = view({ seat: 'B' });
  assert.strictEqual(RV.firstName(B, 'A'), 'Lerato');
  assert.strictEqual(RV.aiName(B, 'B'), 'Your AI');
});

test('names: spectators see both names; a missing name falls back to the seat', () => {
  const R = view({ seat: null });
  assert.strictEqual(RV.firstName(R, 'A'), 'Lerato');
  assert.strictEqual(RV.aiName(R, 'A'), "Lerato's AI");
  assert.strictEqual(RV.aiName(R, 'B'), "Kwame's AI");
  const blank = view({ seats: { A: seat(''), B: seat('  ') } });
  assert.strictEqual(RV.firstName(blank, 'A'), 'Seat A');
  assert.strictEqual(RV.aiName(blank, 'B'), "Seat B's AI");
});

test('names: the URL cannot make anyone "You"; only R.seat does', () => {
  // A spectator view has seat null even if the page URL said seat=A.
  assert.strictEqual(RV.aiName(view({ seat: null }), 'A'), "Lerato's AI");
});

test('names: a reserved name or the other person\'s first name becomes "Person A" / "Person B"', () => {
  const names = (a, b, over) => view(Object.assign({ seats: { A: seat(a), B: seat(b) } }, over));
  for (const bad of ['You', 'you', 'YOUR', ' your Highness ']) {
    const R = names(bad, 'Kwame', { seat: 'B' });
    assert.strictEqual(RV.firstName(R, 'A'), 'Person A', bad);
    assert.strictEqual(RV.aiName(R, 'A'), "Person A's AI");
    assert.strictEqual(RV.firstName(R, 'B'), 'Kwame');
  }
  const same = names('Sam Jones', 'sam Smith');
  assert.strictEqual(RV.firstName(same, 'A'), 'Person A');
  assert.strictEqual(RV.firstName(same, 'B'), 'Person B');
  // "Youssef" is a name, not the word "you"
  assert.strictEqual(RV.firstName(names('Youssef', 'Kwame'), 'A'), 'Youssef');
  // a blank other name is not a clash
  assert.strictEqual(RV.firstName(names('Sam', ''), 'A'), 'Sam');
  // the viewer's own labels stay unambiguous
  const R = names('You', 'Kwame', { seat: 'B' });
  assert.notStrictEqual(RV.aiName(R, 'A'), RV.aiName(view({ seat: 'A' }), 'A'));
});

test('otherSeat and creatorName', () => {
  assert.strictEqual(RV.otherSeat(view({ seat: 'A' })), 'B');
  assert.strictEqual(RV.otherSeat(view({ seat: 'B' })), 'A');
  assert.strictEqual(RV.otherSeat(view({ seat: null })), null);
  assert.strictEqual(RV.otherSeat(null), null);
  assert.strictEqual(RV.creatorName(view({ seat: 'B' })), 'Lerato');
  assert.strictEqual(RV.creatorName(view({ seats: { A: seat(''), B: seat('K') } })), 'Seat A');
});

test('thinkingLabel: names the AI that is working, only while negotiating', () => {
  assert.strictEqual(RV.thinkingLabel(view({ status: 'negotiating', thinking: 'B', seat: 'A' })), "Kwame's AI is thinking");
  assert.strictEqual(RV.thinkingLabel(view({ status: 'negotiating', thinking: 'A', seat: 'A' })), 'Your AI is thinking');
  assert.strictEqual(RV.thinkingLabel(view({ status: 'negotiating', thinking: null })), null);
  assert.strictEqual(RV.thinkingLabel(view({ status: 'paused', thinking: 'A' })), null);
  assert.strictEqual(RV.thinkingLabel(null), null);
});

test('bubbleEnd: viewer on the end, spectators have A on the end', () => {
  assert.strictEqual(RV.bubbleEnd(view({ seat: 'A' }), 'A'), true);
  assert.strictEqual(RV.bubbleEnd(view({ seat: 'A' }), 'B'), false);
  assert.strictEqual(RV.bubbleEnd(view({ seat: 'B' }), 'B'), true);
  assert.strictEqual(RV.bubbleEnd(view({ seat: 'B' }), 'A'), false);
  assert.strictEqual(RV.bubbleEnd(view({ seat: null }), 'A'), true);
  assert.strictEqual(RV.bubbleEnd(view({ seat: null }), 'B'), false);
});

// ---------- claims ----------
test('claimView: stated / sourced / assumed wording for others and for the viewer', () => {
  const R = view({ seat: 'A' });
  const stated = { id: 'B1.1', text: 'We ship daily', origin: 'stated', ref: 'known_facts[0]' };
  const sourced = { id: 'B1.2', text: 'Provider says so', origin: 'sourced', ref: 'Provider docs, page 3' };
  const assumed = { id: 'B1.3', text: 'It never retries', origin: 'assumed' };
  assert.strictEqual(RV.claimView(R, stated).pill, 'Kwame told their AI this');
  assert.strictEqual(RV.claimView(R, sourced).pill, "Kwame's AI points to a source");
  assert.strictEqual(RV.claimView(R, assumed).pill, "Not confirmed. Kwame's AI guessed this.");
  const mine = (c) => Object.assign({}, c, { id: 'A1.1' });
  assert.strictEqual(RV.claimView(R, mine(stated)).pill, 'You told your AI this');
  assert.strictEqual(RV.claimView(R, mine(sourced)).pill, 'Your AI points to a source');
  assert.strictEqual(RV.claimView(R, mine(assumed)).pill, 'Not confirmed. Your AI guessed this.');
});

test('claimView: refs become plain notes; assumed claims have no note and are unconfirmed', () => {
  const R = view();
  const s = RV.claimView(R, { id: 'A1.1', text: 't', origin: 'sourced', ref: 'Provider docs' });
  assert.strictEqual(s.note, 'Provider docs');
  assert.strictEqual(s.unconfirmed, false);
  assert.strictEqual(s.tone, 'neutral');
  const st = RV.claimView(R, { id: 'A1.1', text: 't', origin: 'stated', ref: 'must_never[0]' });
  assert.strictEqual(st.tone, 'party');
  const a = RV.claimView(R, { id: 'A1.1', text: 't', origin: 'assumed', ref: 'must_never[0]' });
  assert.strictEqual(a.note, null);
  assert.strictEqual(a.detail, null);
  assert.strictEqual(a.unconfirmed, true);
  assert.strictEqual(a.tone, 'warn');
  // unknown origin is treated as an assumption
  assert.strictEqual(RV.claimView(R, { id: 'A1.1', text: 't', origin: 'bogus' }).origin, 'assumed');
});

test('claimView: a stated claim\'s ref says whose instructions or answer it came from', () => {
  const stated = (id, ref) => ({ id, text: 't', origin: 'stated', ref });
  const R = view({ seat: 'A' });
  for (const ref of ['must_haves[0]', 'may_agree_to[1]', 'must_never[0]', 'escalate_when[2]', 'known_facts[10]']) {
    assert.strictEqual(RV.claimView(R, stated('B1.1', ref)).note, "From Kwame's instructions", ref);
    assert.strictEqual(RV.claimView(R, stated('A1.1', ref)).note, 'From your instructions', ref);
    assert.strictEqual(RV.claimView(R, stated('B1.1', ref)).detail, null);
  }
  assert.strictEqual(RV.claimView(R, stated('B1.1', 'amendment[0]')).note, "From Kwame's answer");
  assert.strictEqual(RV.claimView(R, stated('A1.1', 'amendment[3]')).note, 'From your answer');
  assert.strictEqual(RV.claimView(view(), stated('B1.1', 'known_facts[0]')).note, "From Kwame's instructions");
  // anything else is shown as the ref itself, as plain text for the page to escape
  const other = RV.claimView(R, stated('B1.1', 'Their message <b>2</b>'));
  assert.strictEqual(other.note, null);
  assert.strictEqual(other.detail, 'Their message <b>2</b>');
  assert.strictEqual(RV.claimView(R, stated('B1.1', 'known_facts')).detail, 'known_facts');
  assert.strictEqual(RV.claimView(R, { id: 'B1.1', text: 't', origin: 'stated' }).detail, null);
  // a clause-shaped ref on a sourced claim names no real source
  const src = (ref) => RV.claimView(R, { id: 'B1.1', text: 't', origin: 'sourced', ref });
  assert.strictEqual(src('known_facts[2]').note, 'No source named');
  assert.strictEqual(src('amendment[0]').note, 'No source named');
  assert.strictEqual(src('Provider docs, page 3').note, 'Provider docs, page 3');
  assert.strictEqual(src(undefined).note, null);
  assert.strictEqual(src('known_facts[2]').detail, null);
});

test('claimView: seat comes from the claim, else from its id', () => {
  const R = view({ seat: 'A' });
  assert.strictEqual(RV.claimView(R, { id: 'A1.1', origin: 'assumed' }).seat, 'A');
  assert.strictEqual(RV.claimView(R, { id: 'B1.1', origin: 'assumed' }).seat, 'B');
  assert.strictEqual(RV.claimView(R, { id: 'A1.1', seat: 'B', origin: 'assumed' }).seat, 'B');
});

test('claimView: reviews come from the registry and read in plain language', () => {
  const claim = { id: 'A1.1', text: 'It never retries', origin: 'assumed' };
  const R = view({
    seat: 'A',
    claims: [{ id: 'A1.1', verified: false, reviews: [
      { by: 'B', verdict: 'challenge', reason: 'Not in the docs', seq: 2 },
      { by: 'A', verdict: 'accept', reason: '', seq: 3 },
      { by: 'B', verdict: 'conflict', reason: 'It does retry', seq: 4 },
    ] }],
  });
  const v = RV.claimView(R, claim);
  assert.strictEqual(v.reviewNotes.length, 3);
  assert.strictEqual(v.reviewNotes[0].sentence, "Kwame's AI couldn't confirm this");
  assert.strictEqual(v.reviewNotes[0].reason, 'Not in the docs');
  assert.strictEqual(v.reviewNotes[1].sentence, 'Your AI accepted this');
  assert.strictEqual(v.reviewNotes[2].sentence, "Kwame's AI disagrees with this");
  assert.strictEqual(v.flagged, true);
  assert.strictEqual(RV.claimView(view(), claim).reviewNotes.length, 0);
  assert.strictEqual(RV.claimView(view(), claim).flagged, false);
  const onlyAccept = view({ claims: [{ id: 'A1.1', reviews: [{ by: 'B', verdict: 'accept', reason: '' }] }] });
  assert.strictEqual(RV.claimView(onlyAccept, claim).flagged, false);
});

test('proposalView: flags a proposal that rests on something not confirmed', () => {
  const R = view({ claims: [{ id: 'A1.1', verified: false }, { id: 'A1.2', verified: true }] });
  const env = (deps) => ({ proposal: { terms: ['t1'], depends_on: deps } });
  assert.deepStrictEqual(RV.proposalView(R, env(['A1.1'])), { terms: ['t1'], unconfirmed: true, note: 'Depends on something not confirmed' });
  assert.deepStrictEqual(RV.proposalView(R, env(['A1.2'])), { terms: ['t1'], unconfirmed: false, note: null });
  assert.strictEqual(RV.proposalView(R, env([])).unconfirmed, false);
  assert.strictEqual(RV.proposalView(R, {}), null);
});

// ---------- flags against the real server ----------
function fakeRoom() {
  const mk = (name) => ({ card: { principal: { name } }, cardHash: 'h' + name });
  return { id: 'room', seats: { A: mk('Lerato'), B: mk('Kwame') }, envelopes: [], claims: {}, ledger: [] };
}
function turn(room, seatId, raw) {
  const env = pxp.buildEnvelope(room, seatId, raw);
  pxp.applyEnvelope(room, env);
  return env;
}

const REAL_FLAGS = {};
{
  // 1. stated without a ref
  let room = fakeRoom();
  REAL_FLAGS.noRef = turn(room, 'A', { message: 'm', claims: [{ text: 'The webhook is "reliable"', origin: 'stated' }] }).protocol_flags;

  // 2. cited the other side as the authority
  room = fakeRoom();
  REAL_FLAGS.otherSide = turn(room, 'A', { message: 'm', claims: [{ text: 'They said it works', origin: 'stated', ref: 'their message' }] }).protocol_flags;

  // 3. agree while raising a conflict
  room = fakeRoom();
  turn(room, 'B', { message: 'm', claims: [{ text: 'claim', origin: 'assumed' }], proposal: { terms: ['t'], depends_on: [] } });
  REAL_FLAGS.conflict = turn(room, 'A', { message: 'm', status: 'agree', reviews: [{ claim_id: 'B1.1', verdict: 'conflict', reason: 'no' }] }).protocol_flags;

  // 4. agree with nothing to accept
  room = fakeRoom();
  REAL_FLAGS.noProposal = turn(room, 'A', { message: 'm', status: 'agree' }).protocol_flags;

  // 5. accept a proposal resting on a disputed claim
  room = fakeRoom();
  turn(room, 'B', { message: 'm', claims: [{ text: 'claim', origin: 'assumed' }], proposal: { terms: ['t'], depends_on: ['new1'] } });
  REAL_FLAGS.blocked = turn(room, 'A', { message: 'm', status: 'agree', reviews: [{ claim_id: 'B1.1', verdict: 'challenge', reason: 'unsure' }] }).protocol_flags;
}

test('flagSentence: each real server flag text gets its own plain sentence, never the fallback', () => {
  const seen = new Set();
  for (const [name, flags] of Object.entries(REAL_FLAGS)) {
    assert.ok(Array.isArray(flags) && flags.length === 1, `${name} was triggered once in isolation: ${JSON.stringify(flags)}`);
    const r = RV.flagSentence(flags[0]);
    assert.notStrictEqual(r.sentence, RV.FLAG_FALLBACK, `${name}: ${flags[0]}`);
    assert.ok(r.sentence.length > 20);
    assert.ok(!/proxy|principal|claim|downgraded|withheld/i.test(r.sentence), r.sentence);
    seen.add(r.sentence);
  }
  assert.strictEqual(seen.size, 5, 'five distinct sentences');
  assert.strictEqual(Object.keys(REAL_FLAGS).length, 5);
});

test('flag rules: one for every flags.push( in lib/pxp.js', () => {
  const src = readRepo('lib/pxp.js');
  const pushes = src.match(/flags\.push\(/g) || [];
  assert.strictEqual(RV.FLAG_RULE_COUNT, pushes.length, 'a new server flag needs a plain sentence in room-view.js');
  assert.strictEqual(RV.FLAG_RULE_COUNT, Object.keys(REAL_FLAGS).length);
});

test('flagSentence: the quoted claim text is returned only as detail', () => {
  const r = RV.flagSentence(REAL_FLAGS.noRef[0]);
  assert.strictEqual(r.detail, 'The webhook is "reliable"');
  assert.ok(!r.sentence.includes('webhook'));
  assert.strictEqual(RV.flagSentence(REAL_FLAGS.otherSide[0]).detail, 'They said it works');
  for (const k of ['conflict', 'noProposal', 'blocked']) assert.strictEqual(RV.flagSentence(REAL_FLAGS[k][0]).detail, null, k);
});

test('flagSentence: anchored, so changed or padded text falls back and is never echoed', () => {
  const real = REAL_FLAGS.conflict[0];
  for (const bad of [real + ' extra', 'x' + real, real.replace('agreement withheld', 'agreement kept'), '', 'Proxy exploded <script>alert(1)</script>', null, undefined, 42, {}, [real]]) {
    const r = RV.flagSentence(bad);
    assert.strictEqual(r.sentence, RV.FLAG_FALLBACK);
    assert.strictEqual(r.detail, null);
    assert.ok(typeof bad !== 'string' || !bad || !r.sentence.includes(bad));
  }
  // a flag object from the brief is accepted
  assert.notStrictEqual(RV.flagSentence({ seq: 2, seat: 'A', flag: real }).sentence, RV.FLAG_FALLBACK);
  // text that smuggles another flag's tail into a claim cannot change which sentence it gets
  const sneaky = 'Claim "x" cited the other side as its authority; downgraded to assumed.';
  assert.strictEqual(RV.flagSentence(sneaky).sentence, RV.flagSentence(REAL_FLAGS.otherSide[0]).sentence);
});

test('flagSentence: a multi-line quoted claim still matches', () => {
  const flag = 'Claim "line one\nline two" was tagged sourced without a reference; downgraded to assumed.';
  const r = RV.flagSentence(flag);
  assert.notStrictEqual(r.sentence, RV.FLAG_FALLBACK);
  assert.strictEqual(r.detail, 'line one\nline two');
});

// ---------- escalations ----------
test('escalationEvents: asked and answered, for another person and for the viewer', () => {
  const env = { from: { seat: 'A' }, escalation: { question: 'Is a duplicate ok?', reason: 'r' }, answer: 'No', answer_via: 'web' };
  const them = RV.escalationEvents(view({ seat: 'B' }), env);
  assert.deepStrictEqual(them, [
    { kind: 'asked', lead: "Lerato's AI asked Lerato:", body: 'Is a duplicate ok?' },
    { kind: 'answered', lead: 'Lerato answered:', body: 'No' },
  ]);
  const me = RV.escalationEvents(view({ seat: 'A' }), env);
  assert.strictEqual(me[0].lead, 'Your AI asked you:');
  assert.strictEqual(me[1].lead, 'You answered:');
});

test('escalationEvents: relayed through an agent, unanswered, and no escalation', () => {
  const env = { from: { seat: 'B' }, escalation: { question: 'q' }, answer: 'yes', answer_via: 'mcp' };
  assert.strictEqual(RV.escalationEvents(view({ seat: 'A' }), env)[1].lead, 'Kwame answered (through their agent):');
  assert.strictEqual(RV.escalationEvents(view({ seat: 'B' }), env)[1].lead, 'You answered (through your agent):');
  const open = RV.escalationEvents(view(), { from: { seat: 'B' }, escalation: { question: 'q' } });
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].kind, 'asked');
  assert.deepStrictEqual(RV.escalationEvents(view(), { from: { seat: 'B' } }), []);
  assert.deepStrictEqual(RV.escalationEvents(view(), null), []);
});

test('escalationEvents never put the AI\'s reason on screen', () => {
  const env = { from: { seat: 'A' }, escalation: { question: 'q', reason: 'SECRET REASON' } };
  assert.ok(!JSON.stringify(RV.escalationEvents(view(), env)).includes('SECRET REASON'));
});

// ---------- messages and decisions ----------
test('messageView: everything one message needs, for the viewer and for the other side', () => {
  const env = {
    seq: 3, from: { seat: 'B' }, status: 'continue', message: 'hello',
    claims: [{ id: 'B3.1', text: 'We ship daily', origin: 'stated', ref: 'known_facts[0]' }],
    proposal: { terms: ['t1'], depends_on: ['B3.1'] },
    protocol_flags: [REAL_FLAGS.conflict[0], 'Some new unmatched text'],
  };
  const R = view({ seat: 'A', claims: [{ id: 'B3.1', verified: false, reviews: [] }] });
  const m = RV.messageView(R, env);
  assert.deepStrictEqual(Object.keys(m).sort(), ['acceptEvent', 'announce', 'ariaLabel', 'claims', 'end', 'escalationEvents', 'flags', 'proposal', 'seat', 'seq', 'speaker']);
  assert.strictEqual(m.seq, 3);
  assert.strictEqual(m.seat, 'B');
  assert.strictEqual(m.end, false);
  assert.strictEqual(m.speaker, "Kwame's AI");
  assert.strictEqual(m.ariaLabel, "Kwame's AI, message 3");
  assert.strictEqual(m.announce, "Kwame's AI sent a message");
  assert.strictEqual(m.claims.length, 1);
  assert.strictEqual(m.claims[0].note, "From Kwame's instructions");
  assert.strictEqual(m.proposal.unconfirmed, true);
  assert.strictEqual(m.acceptEvent, null);
  assert.deepStrictEqual(m.escalationEvents, []);
  assert.strictEqual(m.flags.length, 2);
  assert.notStrictEqual(m.flags[0].sentence, RV.FLAG_FALLBACK);
  assert.strictEqual(m.flags[1].sentence, RV.FLAG_FALLBACK);
  assert.ok(!JSON.stringify(m.flags).includes('unmatched'));

  const mine = RV.messageView(view({ seat: 'B' }), env);
  assert.strictEqual(mine.end, true);
  assert.strictEqual(mine.speaker, 'Your AI');
  assert.strictEqual(RV.messageView(view({ seat: null }), env).end, false);
});

test('messageView: accepts, escalations and bare messages', () => {
  const R = view({ seat: 'A' });
  const accept = RV.messageView(R, { seq: 4, from: { seat: 'A' }, status: 'agree' });
  assert.strictEqual(accept.acceptEvent, 'Your AI accepted the proposal');
  assert.strictEqual(accept.announce, 'Your AI accepted the proposal');
  assert.deepStrictEqual([accept.claims, accept.flags, accept.proposal], [[], [], null]);
  const esc = RV.messageView(R, { seq: 5, from: { seat: 'B' }, status: 'escalate', escalation: { question: 'Ok?', reason: 'SECRET' }, answer: 'Yes' });
  assert.strictEqual(esc.announce, "Kwame's AI asked Kwame a question");
  assert.strictEqual(esc.escalationEvents.length, 2);
  assert.ok(!JSON.stringify(esc).includes('SECRET'));
  assert.doesNotThrow(() => RV.messageView(null, null));
});

test('newMessagesAnnouncement: one line for what arrived, nothing when nothing did', () => {
  const envelopes = [
    { seq: 1, from: { seat: 'A' }, status: 'continue' },
    { seq: 2, from: { seat: 'B' }, status: 'continue' },
    { seq: 3, from: { seat: 'A' }, status: 'agree' },
  ];
  const R = view({ seat: 'A', envelopes });
  assert.strictEqual(RV.newMessagesAnnouncement(R, [2]), "Kwame's AI sent a message");
  assert.strictEqual(RV.newMessagesAnnouncement(R, [3]), 'Your AI accepted the proposal');
  assert.strictEqual(RV.newMessagesAnnouncement(R, [2, 3]), '2 new messages');
  assert.strictEqual(RV.newMessagesAnnouncement(R, []), null);
  assert.strictEqual(RV.newMessagesAnnouncement(R, [9]), null);
  assert.strictEqual(RV.newMessagesAnnouncement(R, undefined), null);
  assert.strictEqual(RV.newMessagesAnnouncement(null, [1]), null);
});

test('decisionView: the question is the heading, never the reason', () => {
  const pending = { seat: 'A', seq: 4, question: 'Is a duplicate ok?', reason: 'SECRET REASON', options: null };
  const d = RV.decisionView(view({ status: 'paused', seat: 'A', pending }));
  assert.deepStrictEqual(d, {
    key: 4, heading: 'Is a duplicate ok?', question: 'Is a duplicate ok?', options: null,
    textarea: { label: 'Your answer', hint: 'Your AI carries on from what you write' },
    visibilityNote: 'Kwame and their AI will see your answer.',
    dockText: 'Your AI needs you · Answer',
  });
  assert.ok(!JSON.stringify(d).includes('SECRET'));
  assert.strictEqual(RV.decisionView(view({ status: 'paused', seat: 'B', pending: { seat: 'B', seq: 1, question: 'q' } })).visibilityNote, 'Lerato and their AI will see your answer.');
});

test('decisionView: demo options, not your question, and missing questions', () => {
  const options = [{ key: 'dedupe', label: 'Insist on a check' }, { key: 'accept', label: 'Accept their plan' }];
  const demo = RV.decisionView(view({ demo: true, seat: 'B', status: 'paused', pending: { seat: 'A', seq: 2, question: 'q', options } }));
  assert.deepStrictEqual(demo.options, options);
  assert.strictEqual(demo.visibilityNote, 'Kwame and their AI will see your answer.', 'the answering side is the pending seat');
  assert.strictEqual(RV.decisionView(view({ seat: 'B', pending: { seat: 'A', seq: 2, question: 'q' } })), null);
  assert.strictEqual(RV.decisionView(view({ seat: null, pending: { seat: 'A', seq: 2, question: 'q' } })), null);
  assert.strictEqual(RV.decisionView(view({ seat: 'A' })), null);
  assert.strictEqual(RV.decisionView(null), null);
  const blank = RV.decisionView(view({ seat: 'A', pending: { seat: 'A', seq: 2 } }));
  assert.strictEqual(blank.heading, 'Your AI has a question for you');
  assert.strictEqual(RV.decisionView(view({ seat: 'A', pending: { seat: 'A', seq: 2, question: 'q', options: [] } })).options, null);
});

test('recordStatus and guessNote wording', () => {
  assert.strictEqual(RV.recordStatus(true), 'Record checks out');
  assert.strictEqual(RV.recordStatus(false), 'Record was changed');
  assert.strictEqual(RV.recordStatus(undefined), 'Record was changed');
  assert.strictEqual(RV.guessNote(view({ seat: 'A' }), 'B'), "Not confirmed. Kwame's AI guessed this.");
});

// ---------- record ----------
test('recordEntry: plain wording per ledger type', () => {
  const R = view({ seat: 'A' });
  const e = (type, data) => RV.recordEntry(R, { type, data: data || {} });
  assert.strictEqual(e('room_opened', { topic: 't' }), 'Room opened');
  assert.strictEqual(e('card_sealed', { seat: 'A', via: 'web' }), 'You locked your instructions');
  assert.strictEqual(e('card_sealed', { seat: 'B', via: 'web' }), 'Kwame locked their instructions');
  assert.strictEqual(e('card_sealed', { seat: 'B', via: 'mcp' }), 'Kwame locked their instructions (through their agent)');
  assert.strictEqual(e('agent_joined', { seat: 'B', agent: 'Claude' }), "Kwame's agent connected");
  assert.strictEqual(e('agent_joined', { seat: 'A', agent: 'Claude' }), 'Your agent connected');
  assert.strictEqual(e('envelope', { seat: 'B', status: 'continue' }), "Kwame's AI sent a message");
  assert.strictEqual(e('envelope', { seat: 'A', status: 'agree' }), 'Your AI accepted the proposal');
  assert.strictEqual(e('escalation', { seat: 'B' }), 'Kwame\'s AI asked Kwame a question');
  assert.strictEqual(e('escalation', { seat: 'A' }), 'Your AI asked you a question');
  assert.strictEqual(e('principal_answer', { seat: 'A', via: 'web' }), 'You answered');
  assert.strictEqual(e('principal_answer', { seat: 'B', via: 'mcp' }), 'Kwame answered (through their agent)');
  assert.strictEqual(e('agreement', {}), 'Deal reached');
  assert.strictEqual(e('turn_limit', { turns: 12 }), 'The AIs ran out of turns without a deal');
});

test('recordEntry: unknown or malformed entries get a fixed sentence', () => {
  const R = view();
  assert.strictEqual(RV.recordEntry(R, { type: 'something_new', data: { seat: 'A' } }), 'Something happened in the room');
  assert.strictEqual(RV.recordEntry(R, {}), 'Something happened in the room');
  assert.strictEqual(RV.recordEntry(R, null), 'Something happened in the room');
  assert.strictEqual(RV.recordEntry(R, { type: 'card_sealed' }), 'Someone locked their instructions');
  assert.strictEqual(RV.recordEntry(R, { type: 'card_sealed', data: { seat: 'Z' } }), 'Someone locked their instructions');
});

test('recordEntry: covers every ledger type the server writes', () => {
  const src = readRepo('index.js') + readRepo('lib/pxp.js');
  const types = new Set([...src.matchAll(/appendLedger\(\w+, '([a-z_]+)'/g)].map(m => m[1]));
  assert.ok(types.size >= 7, [...types].join());
  for (const t of types) assert.notStrictEqual(RV.recordEntry(view(), { type: t, data: { seat: 'A' } }), 'Something happened in the room', t);
});

// ---------- errors ----------
test('errorMessage: fixed sentences per action, status-specific where it helps', () => {
  const actions = ['seal', 'draft', 'answer', 'resume', 'create', 'demo'];
  for (const a of actions) {
    const m = RV.errorMessage(a, 500);
    assert.ok(m.length > 10 && /[.]$/.test(m), a);
    assert.strictEqual(RV.errorMessage(a, undefined), m, `${a} default without a status`);
    assert.strictEqual(RV.errorMessage(a, 418), m, `${a} unknown status`);
  }
  assert.strictEqual(RV.errorMessage('create', 429), "You've reached today's limit for new rooms. Try again tomorrow, or watch the demo.");
  assert.strictEqual(RV.errorMessage('create', 403), "That passcode didn't work. Check it and try again.");
  assert.strictEqual(RV.errorMessage('create', 503), 'This server has no built-in AI, so each person brings their own AI agent.');
  assert.strictEqual(RV.errorMessage('seal', 409), 'Your instructions are already locked.');
  assert.strictEqual(RV.errorMessage('answer', 409), "There's no question waiting for you. It may already be answered.");
  assert.strictEqual(RV.errorMessage('resume', 409), "The room can't be restarted right now.");
  assert.strictEqual(RV.errorMessage('seal', 400), 'Something is missing. Say what you are trying to achieve and add at least one thing the deal must include.');
  assert.ok(/fill in the fields yourself/.test(RV.errorMessage('draft', 503)));
  assert.strictEqual(RV.errorMessage('draft', 429), "You've used all the drafts for this place. Fill in the fields yourself.");
  assert.strictEqual(RV.errorMessage('seal', 403), RV.errorMessage('answer', 403));
  // the demo route has no failure codes of its own
  assert.strictEqual(RV.errorMessage('demo', 429), RV.errorMessage('demo', 500));
});

// Which index.js code regions belong to which action. Codes outside these (invalid JSON 400,
// body too large 413, unknown room 404, unknown seat 400) are shared by every route and are
// explicitly allowed to use the action's default sentence.
function codesIn(src, startMarker, endMarker) {
  const from = src.indexOf(startMarker);
  assert.ok(from >= 0, startMarker);
  const to = endMarker ? src.indexOf(endMarker, from + startMarker.length) : src.length;
  assert.ok(to > from, endMarker);
  return new Set([...src.slice(from, to).matchAll(/(?:send\(res, |ApiError\()([45]\d{2})/g)].map(m => Number(m[1])));
}

test('errorMessage: every code index.js returns for an action has its own sentence', () => {
  const src = readRepo('index.js');
  // the check every seat action passes before its own code
  const seatGate = codesIn(src, "if (!seat) return send(res, 403", "const action = parts[5]");
  const regions = {
    create: codesIn(src, 'function createLiveRoom', 'function sealCard'),
    demo: codesIn(src, "parts[1] === 'demo'", "parts[1] === 'rooms' && parts.length === 2"),
    draft: codesIn(src, "if (action === 'draft')", "if (action === 'seal')"),
    seal: codesIn(src, 'function sealCard', 'function joinAsAgent'),
    answer: codesIn(src, 'function answerEscalation', 'function resume'),
    resume: codesIn(src, 'function resume', 'const ops = {'),
  };
  // the answer route has its own demo branch with a 409
  for (const c of codesIn(src, "if (action === 'answer')", "if (action === 'resume')")) regions.answer.add(c);
  for (const a of ['draft', 'seal', 'answer', 'resume']) for (const c of seatGate) regions[a].add(c);
  assert.ok(regions.draft.has(429) && regions.draft.has(502) && regions.draft.has(503) && regions.draft.has(409), [...regions.draft].join());
  assert.ok(regions.create.has(429) && regions.create.has(403) && regions.create.has(503));

  for (const [action, codes] of Object.entries(regions)) {
    const generic = RV.errorMessage(action, 599);
    for (const code of codes) assert.notStrictEqual(RV.errorMessage(action, code), generic, `${action} ${code}`);
    // and no sentence for a code the route can't return
    for (let code = 400; code < 600; code++) {
      if (RV.errorMessage(action, code) !== generic) assert.ok(codes.has(code), `${action} has a sentence for ${code}, which index.js never returns for it`);
    }
  }
});

test('errorMessage: network failure and unknown actions use fixed fallbacks', () => {
  assert.strictEqual(RV.errorMessage('seal', 0), "We couldn't reach the server. Check your connection and try again.");
  assert.strictEqual(RV.errorMessage('nope', 500), 'Something went wrong. Please try again.');
  assert.strictEqual(RV.errorMessage(undefined, undefined), 'Something went wrong. Please try again.');
  assert.strictEqual(RV.errorMessage(undefined, 0), "We couldn't reach the server. Check your connection and try again.");
});

test('errorMessage: prototype names are not actions, and "def" is not a status', () => {
  for (const a of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.strictEqual(RV.errorMessage(a, 400), 'Something went wrong. Please try again.', a);
  }
  assert.strictEqual(RV.errorMessage('seal', 'def'), RV.errorMessage('seal', 500));
  assert.strictEqual(RV.errorMessage('seal', '__proto__'), RV.errorMessage('seal', 500));
});

test('errorMessage: never contains or reflects server text', () => {
  const msg = RV.errorMessage('seal', 400, 'Daily room limit reached <b>x</b>');
  assert.ok(!/Daily|<b>/.test(msg));
  assert.strictEqual(RV.errorMessage.length, 2);
});

// ---------- fingerprints and decision key ----------
test('fingerprint: stable for identical input', () => {
  const env = { seq: 2, claims: [{ id: 'A2.1' }] };
  const R = view({ claims: [{ id: 'A2.1', reviews: [] }] });
  assert.strictEqual(RV.fingerprint(R, env), RV.fingerprint(JSON.parse(JSON.stringify(R)), JSON.parse(JSON.stringify(env))));
});

test('fingerprint: a later answer changes it', () => {
  const R = view();
  const before = RV.fingerprint(R, { seq: 2, claims: [], escalation: { question: 'q' } });
  const answered = RV.fingerprint(R, { seq: 2, claims: [], escalation: { question: 'q' }, answer: 'No', answer_via: 'web' });
  const via = RV.fingerprint(R, { seq: 2, claims: [], escalation: { question: 'q' }, answer: 'No', answer_via: 'mcp' });
  const other = RV.fingerprint(R, { seq: 2, claims: [], escalation: { question: 'q' }, answer: 'Yes', answer_via: 'web' });
  assert.strictEqual(new Set([before, answered, via, other]).size, 4);
});

test('fingerprint: a later review of one of the message\'s claims changes it', () => {
  const env = { seq: 2, claims: [{ id: 'A2.1' }, { id: 'A2.2' }] };
  const reg = (reviews) => view({ claims: [{ id: 'A2.1', reviews }, { id: 'A2.2', reviews: [] }] });
  const none = RV.fingerprint(reg([]), env);
  const challenged = RV.fingerprint(reg([{ by: 'B', verdict: 'challenge', reason: 'r', seq: 3 }]), env);
  const conflict = RV.fingerprint(reg([{ by: 'B', verdict: 'conflict', reason: 'r', seq: 3 }]), env);
  const two = RV.fingerprint(reg([{ by: 'B', verdict: 'challenge', seq: 3 }, { by: 'A', verdict: 'accept', seq: 4 }]), env);
  assert.strictEqual(new Set([none, challenged, conflict, two]).size, 4);
});

test('fingerprint: unrelated changes do not re-render a message', () => {
  const env = { seq: 2, claims: [{ id: 'A2.1' }] };
  const reg = (extra) => view(Object.assign({ claims: [{ id: 'A2.1', reviews: [] }, { id: 'B3.1', reviews: [] }] }, extra));
  const base = RV.fingerprint(reg(), env);
  assert.strictEqual(RV.fingerprint(reg({ turnCount: 9, thinking: 'B' }), env), base);
  const otherClaimReviewed = view({ claims: [{ id: 'A2.1', reviews: [] }, { id: 'B3.1', reviews: [{ by: 'A', verdict: 'challenge' }] }] });
  assert.strictEqual(RV.fingerprint(otherClaimReviewed, env), base);
  assert.ok(typeof RV.fingerprint(null, null) === 'string');
});

test('fingerprint: a review reason change alone is not a verdict change', () => {
  const env = { seq: 2, claims: [{ id: 'A2.1' }] };
  const reg = (reason) => view({ claims: [{ id: 'A2.1', reviews: [{ by: 'B', verdict: 'challenge', reason }] }] });
  assert.strictEqual(RV.fingerprint(reg('a'), env), RV.fingerprint(reg('b'), env));
});

// A memo keyed on the claims array and its length would serve the old claim here: the array is
// the same object and the same length, only an element was replaced.
test('a claim replaced in place (same array, same length) shows up in fingerprint and claimView', () => {
  const R = view({ claims: [{ id: 'A2.1', reviews: [] }, { id: 'A2.2', reviews: [] }] });
  const env = { seq: 2, claims: [{ id: 'A2.1' }] };
  const claim = { id: 'A2.1', text: 't', origin: 'assumed' };
  const fpBefore = RV.fingerprint(R, env);
  assert.strictEqual(RV.claimView(R, claim).flagged, false);
  const same = R.claims;
  R.claims[0] = Object.assign({}, R.claims[0], { reviews: [{ by: 'B', verdict: 'conflict', reason: 'r' }] });
  assert.strictEqual(R.claims, same);
  assert.strictEqual(R.claims.length, 2);
  assert.notStrictEqual(RV.fingerprint(R, env), fpBefore);
  assert.strictEqual(RV.claimView(R, claim).flagged, true);
});

test('fingerprint and claimView resolve duplicate ids as before: fingerprint last wins, claimView first wins', () => {
  const R = view({ claims: [{ id: 'A2.1', reviews: [{ by: 'B', verdict: 'conflict' }] }, { id: 'A2.1', reviews: [] }] });
  assert.strictEqual(RV.fingerprint(R, { seq: 2, claims: [{ id: 'A2.1' }] }), JSON.stringify(['', '', 'A2.1:']));
  assert.strictEqual(RV.claimView(R, { id: 'A2.1', origin: 'assumed' }).flagged, true);
});

test('who: an unknown form throws a TypeError, and via is explicit', () => {
  const R = view({ seat: 'A' });
  assert.strictEqual(RV.who(R, 'A', 'via'), ' (through your agent)');
  assert.strictEqual(RV.who(R, 'B', 'via'), ' (through their agent)');
  for (const bad of [undefined, 'nope', 'YOU', '']) assert.throws(() => RV.who(R, 'A', bad), TypeError);
});

test('LIST_KEYS mirrors the protocol list fields, and INSTRUCTION_FIELDS covers them', () => {
  assert.deepStrictEqual(RV.LIST_KEYS, pxp.LIST_FIELDS);
  assert.deepStrictEqual(RV.INSTRUCTION_FIELDS.filter(f => f.list).map(f => f.key), pxp.LIST_FIELDS);
});

test('decisionKey: changes only when pending.seq changes', () => {
  const a = RV.decisionKey(view({ pending: { seat: 'A', seq: 4, question: 'one' } }));
  assert.strictEqual(a, 4);
  assert.strictEqual(RV.decisionKey(view({ pending: { seat: 'A', seq: 4, question: 'reworded', options: [] }, turnCount: 99, status: 'paused' })), a);
  assert.notStrictEqual(RV.decisionKey(view({ pending: { seat: 'A', seq: 6 } })), a);
  assert.strictEqual(RV.decisionKey(view({ pending: null })), null);
  assert.strictEqual(RV.decisionKey(null), null);
});

// ---------- instructions helpers ----------
test('cardFromFields: goal is one string, lists split on lines, blanks dropped', () => {
  const card = RV.cardFromFields({
    name: ' Lerato ', role: 'Owner', goal: '  Confirm paid orders  ',
    must_haves: 'one\n\n two \r\nthree', may_agree_to: '', must_never: 'double fulfil',
    escalate_when: '   \n', known_facts: 'a\nb',
  }, {});
  assert.deepStrictEqual(card, {
    principal: { name: 'Lerato', role: 'Owner' }, goal: 'Confirm paid orders',
    must_haves: ['one', 'two', 'three'], may_agree_to: [], must_never: ['double fulfil'], escalate_when: [], known_facts: ['a', 'b'],
  });
  assert.strictEqual(typeof card.goal, 'string');
});

test('cardFromFields: org and role are carried through from the seat unless the form sets them', () => {
  const info = { name: 'Lerato', role: 'Owner', org: 'Shop Co' };
  const c = RV.cardFromFields({ goal: 'g', must_haves: 'm' }, info);
  assert.deepStrictEqual(c.principal, { name: 'Lerato', role: 'Owner', org: 'Shop Co' });
  const c2 = RV.cardFromFields({ goal: 'g', must_haves: 'm', name: 'L2', role: '', org: 'Other' }, info);
  assert.deepStrictEqual(c2.principal, { name: 'L2', role: '', org: 'Other' });
  assert.ok(!('org' in RV.cardFromFields({ goal: 'g', must_haves: 'm' }, { name: 'x' }).principal));
  assert.doesNotThrow(() => RV.cardFromFields());
});

test('cardFromFields output is accepted by the server card normaliser', () => {
  const card = pxp.normaliseCard(RV.cardFromFields({ goal: 'g', must_haves: 'a\nb', must_never: 'c' }, { name: 'L', org: 'O' }), 'L');
  assert.deepStrictEqual(card.must_haves, ['a', 'b']);
  assert.strictEqual(card.principal.org, 'O');
  assert.deepStrictEqual(pxp.validateCard(card), []);
});

test('fieldsFromCard: round trips and carries org', () => {
  const card = { principal: { name: 'Lerato', role: 'Owner', org: 'Shop Co' }, goal: 'G', must_haves: ['a', 'b'], may_agree_to: ['c'], must_never: [], escalate_when: ['d'], known_facts: ['e', 'f'], amendments: [] };
  const f = RV.fieldsFromCard(card);
  assert.strictEqual(f.goal, 'G');
  assert.strictEqual(f.must_haves, 'a\nb');
  assert.strictEqual(f.must_never, '');
  assert.strictEqual(f.org, 'Shop Co');
  assert.strictEqual(f.name, 'Lerato');
  const back = RV.cardFromFields(f, {});
  assert.deepStrictEqual(back, { principal: card.principal, goal: 'G', must_haves: card.must_haves, may_agree_to: card.may_agree_to, must_never: [], escalate_when: card.escalate_when, known_facts: card.known_facts });
});

test('fieldsFromCard: empty or malformed cards give empty fields', () => {
  for (const c of [null, undefined, {}, 'x', { principal: null, must_haves: 'single' }]) {
    const f = RV.fieldsFromCard(c);
    assert.strictEqual(f.goal, '');
    assert.strictEqual(f.name, '');
    assert.strictEqual(typeof f.must_haves, 'string');
  }
  assert.strictEqual(RV.fieldsFromCard({ must_haves: 'single\nline' }).must_haves, 'single\nline');
});

test('validateFields: goal and at least one must-have are required', () => {
  assert.deepStrictEqual(RV.validateFields({ goal: 'g', must_haves: 'a' }), {});
  assert.deepStrictEqual(Object.keys(RV.validateFields({})).sort(), ['goal', 'must_haves']);
  assert.deepStrictEqual(Object.keys(RV.validateFields({ goal: '   ', must_haves: 'a' })), ['goal']);
  assert.deepStrictEqual(Object.keys(RV.validateFields({ goal: 'g', must_haves: ' \n \n' })), ['must_haves']);
  assert.deepStrictEqual(Object.keys(RV.validateFields({ goal: 'g', must_haves: [] })), ['must_haves']);
  assert.strictEqual(RV.validateFields({}).goal, 'Say what you are trying to achieve.');
  assert.strictEqual(RV.validateFields({}).must_haves, 'Add at least one thing the deal must include.');
  assert.deepStrictEqual(RV.validateFields(null).goal && Object.keys(RV.validateFields(null)).sort(), ['goal', 'must_haves']);
});

test('INSTRUCTION_FIELDS: the six plain fields with their hints', () => {
  const f = RV.INSTRUCTION_FIELDS;
  assert.deepStrictEqual(f.map(x => x.key), ['goal', 'must_haves', 'may_agree_to', 'must_never', 'escalate_when', 'known_facts']);
  assert.deepStrictEqual(f.map(x => x.label), [
    'What are you trying to achieve?', 'What must the deal include?', 'What can your AI agree to without asking you?',
    'What should it never agree to?', 'When should it stop and ask you?', 'Things you know for sure',
  ]);
  assert.deepStrictEqual(f.filter(x => x.required).map(x => x.key), ['goal', 'must_haves']);
  assert.strictEqual(f[0].list, false);
  assert.strictEqual(f[0].hint, null);
  assert.ok(f.slice(1).every(x => x.list && x.hint.startsWith('Put each point on its own line')));
  assert.ok(f[5].hint.includes('Your AI can say these as your own words'));
  // every field is a card field the server knows
  for (const x of f.slice(1)) assert.ok(pxp.LIST_FIELDS.includes(x.key), x.key);
});

// ---------- purity and plain language ----------
test('room-view is pure: no DOM, UI, markup or storage', () => {
  assertPure(codeOf(RV_PATH));
});

test('every reader-facing string avoids protocol jargon', () => {
  const R = view({ seat: 'A', status: 'paused', pending: { seat: 'B', seq: 1 } });
  const strings = [
    RV.status(R).label, RV.guessPill(view({ claims: [{ verified: false }] })), RV.waitingEvent(R),
    RV.errorMessage('seal', 400), RV.errorMessage('create', 429), RV.errorMessage('resume', 409),
    RV.recordEntry(R, { type: 'envelope', data: { seat: 'A' } }), RV.recordEntry(R, { type: 'escalation', data: { seat: 'B' } }),
    RV.claimView(R, { id: 'B1.1', origin: 'assumed', text: 'x' }).pill, RV.claimView(R, { id: 'B1.1', origin: 'stated', text: 'x', ref: 'r' }).pill,
    ...RV.INSTRUCTION_FIELDS.map(f => f.label + ' ' + (f.hint || '')), RV.FLAG_FALLBACK,
  ];
  for (const s of strings) assert.ok(!JARGON.test(s), s);
});

test('escalation with no question gets the plain fallback sentence, not protocol wording', () => {
  for (const escalation of [undefined, {}, { question: '' }, { question: '   ' }, { reason: 'why' }]) {
    const room = fakeRoom();
    const raw = { status: 'escalate', say: 'hold on' };
    if (escalation !== undefined) raw.escalation = escalation;
    const env = pxp.buildEnvelope(room, 'A', raw);
        assert.strictEqual(env.escalation.question, 'Your AI needs a decision before it can continue.');
    assert.ok(!/proxy|principal/i.test(env.escalation.question));
  }
  const given = pxp.buildEnvelope(fakeRoom(), 'A', { status: 'escalate', say: 'x', escalation: { question: 'Real question?' } });
  assert.strictEqual(given.escalation.question, 'Real question?');
});
