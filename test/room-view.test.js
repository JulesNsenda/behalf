'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { readRepo, serverSource } = require('../test-support/paths');

const { loadPure } = require('../test-support/source');
const { JARGON } = require('../test-support/copy');
const pxp = require('../lib/pxp');

// No window here, so room-view.js sets module.exports.
const { mod: RV, assertClean } = loadPure('room-view');

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
  for (const k of RV.STEPS.filter((k) => k !== 'not-found')) assert.ok(seen.has(k), `${k} is reachable`);
  assert.ok(!RV.STEPS.includes('invalid-link') && !RV.STEPS.includes('preview'), 'banners, not steps');
});

test('step: invalid link (credentials in the URL, no confirmed seat)', () => {
  const s = RV.step(view(), { hadCredentials: true });
  assert.strictEqual(s.key, 'spectator-drafting');
  assert.strictEqual(s.banner, 'invalid-link');
  assert.strictEqual(s.readOnly, true);
  const later = RV.step(view({ status: 'negotiating' }), { hadCredentials: true });
  assert.deepStrictEqual([later.key, later.banner, later.readOnly, later.connectCallout], ['conversation', 'invalid-link', true, false]);
});

test('step: bad token behaves like a missing seat, whatever the URL said', () => {
  // The server confirms seats. A URL that says seat=A with a wrong token arrives as R.seat === null.
  const s = RV.step(view({ seat: null }), { hadCredentials: true, welcomeSeen: true, previewSeat: 'B' });
  assert.strictEqual(s.banner, 'invalid-link');
  assert.notStrictEqual(s.key, 'instructions');
});

test('step: no credentials in the URL and no seat is a spectator, not an invalid link', () => {
  assert.strictEqual(RV.step(view(), { hadCredentials: false }).key, 'spectator-drafting');
  assert.strictEqual(RV.step(view(), { hadCredentials: false }).banner, null);
  const s = RV.step(view({ status: 'negotiating' }), {});
  assert.strictEqual(s.key, 'conversation');
  assert.strictEqual(s.readOnly, true);
});

test('step: a demo room never shows the invalid-link step', () => {
  assert.strictEqual(RV.step(view({ demo: true }), { hadCredentials: true }).key, 'spectator-drafting');
  assert.strictEqual(RV.step(view({ demo: true }), { hadCredentials: true }).banner, null);
});

test('step: preview only while the previewed seat has not locked, and only without a seat', () => {
  assert.deepStrictEqual(RV.step(view(), { previewSeat: 'B' }), { key: 'welcome', banner: 'preview', readOnly: true, connectCallout: false });
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
  // a restart is nobody's fault: interrupted with no error says so, and a seat can resume
  const RESTART = 'The room was interrupted when the server restarted.';
  assert.deepStrictEqual(RV.problem(view({ status: 'paused', interrupted: true, seat: 'B', turn: 'B' })), { text: RESTART, canResume: true });
  assert.deepStrictEqual(RV.problem(view({ status: 'paused', interrupted: true, seat: 'B', turn: 'A' })), { text: RESTART, canResume: true });
  assert.deepStrictEqual(RV.problem(view({ status: 'paused', interrupted: true, turn: 'A' })), { text: RESTART, canResume: false });
  // a real failure still blames the AI, even if the flag is also set
  assert.deepStrictEqual(RV.problem(view({ status: 'error', interrupted: true, error: 'boom', seat: 'B', turn: 'A' })), { text: "Lerato's AI hit a problem.", canResume: true });
  assert.deepStrictEqual(RV.problem(view({ status: 'error', interrupted: false, error: 'boom', seat: 'B', turn: 'B' })), { text: 'Your AI hit a problem.', canResume: true });
  assert.ok(!JARGON.test(RESTART));
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

test('noDealReason: a live room stalled before its turn limit reached the AI allowance, and the outcome reads "No deal. ..."', () => {
  const spent = view({ status: 'stalled', turnCount: 3, maxTurns: 8 });
  assert.strictEqual(RV.noDealReason(spent), 'The room reached its limit on AI use.');
  assert.strictEqual(RV.outcome(spent).text, 'No deal. The room reached its limit on AI use.');
  const atLimit = view({ status: 'stalled', turnCount: 8, maxTurns: 8 });
  assert.strictEqual(RV.noDealReason(atLimit), "The AIs didn't agree within 8 turns.");
  assert.strictEqual(RV.noDealReason(view({ status: 'stalled', turnCount: 3, maxTurns: 8, demo: true })), "The AIs didn't agree within 8 turns.", 'a demo that ran out of script');
  assert.ok(!JARGON.test(RV.noDealReason(spent)));
});

test('noDealReason: names the turn limit only when it is a positive whole number', () => {
  assert.strictEqual(RV.noDealReason(view({ maxTurns: 8 })), "The AIs didn't agree within 8 turns.");
  const FALLBACK = "The AIs didn't agree in the turns they had.";
  for (const bad of [undefined, null, 0, -3, 2.5, NaN, Infinity, '12', {}, [12]]) {
    assert.strictEqual(RV.noDealReason(view({ maxTurns: bad })), FALLBACK, String(bad));
    assert.strictEqual(RV.outcome(view({ status: 'stalled', maxTurns: bad })).text, 'No deal. ' + FALLBACK);
  }
  assert.strictEqual(RV.noDealReason(null), FALLBACK);
  assert.ok(!JARGON.test(FALLBACK));
});

test('guessPill and outcome wording', () => {
  assert.strictEqual(RV.guessPill(view({ claims: [] })), null);
  assert.strictEqual(RV.guessPill(view({ claims: [{ id: 'A1.1', verified: false }] })), '1 guess not confirmed');
  assert.strictEqual(RV.guessPill(view({ claims: [{ verified: false }, { verified: false }] })), '2 guesses not confirmed');
  const dep = (n) => ({ unverified_dependencies: Array.from({ length: n }, (_, i) => ({ id: 'A1.' + i })) });
  const SEE = 'See the agreement';
  const FAILED = 'See what happened';
  assert.deepStrictEqual(RV.outcome(view({ status: 'agreed', brief: dep(0) })), { tone: 'ok', text: 'Deal reached. Nothing unconfirmed.', linkLabel: SEE, replayable: false });
  assert.deepStrictEqual(RV.outcome(view({ status: 'agreed', brief: dep(1) })), { tone: 'warn', text: 'Deal reached, with 1 unconfirmed point', linkLabel: SEE, replayable: false });
  assert.deepStrictEqual(RV.outcome(view({ status: 'agreed', brief: dep(3) })), { tone: 'warn', text: 'Deal reached, with 3 unconfirmed points', linkLabel: SEE, replayable: false });
  assert.deepStrictEqual(RV.outcome(view({ status: 'stalled', turnCount: 12 })), { tone: 'warn', text: "No deal. The AIs didn't agree within 12 turns.", linkLabel: FAILED, replayable: false });
  assert.deepStrictEqual(RV.outcome(view({ status: 'stalled', turnCount: 1, maxTurns: 1 })), { tone: 'warn', text: "No deal. The AIs didn't agree within 1 turn.", linkLabel: FAILED, replayable: false });
  assert.strictEqual(RV.outcome(view({ status: 'negotiating' })), null);
  assert.strictEqual(RV.outcome(null), null);
});

test('outcome: replayable only for the viewer of a demo that has ended', () => {
  const ended = { status: 'agreed', brief: { unverified_dependencies: [] } };
  assert.strictEqual(RV.outcome(view({ ...ended, demo: true, seat: 'A' })).replayable, true);
  assert.strictEqual(RV.outcome(view({ ...ended, demo: true, seat: null })).replayable, false, 'a spectator can not replay');
  assert.strictEqual(RV.outcome(view({ ...ended, demo: false, seat: 'A' })).replayable, false, 'a real room is not replayed');
  assert.strictEqual(RV.outcome(view({ status: 'stalled', demo: true, seat: 'B' })).replayable, true);
  assert.strictEqual(RV.outcome(view({ status: 'negotiating', demo: true, seat: 'A' })), null);
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

test('names: the joiners a spelling needs stay, the rest of the format characters go', () => {
  const ZWNJ = '\u200C';
  const ZWJ = '\u200D';
  const persian = 'می' + ZWNJ + 'خواهم'; // "mi-khaham": the ZWNJ is part of the spelling
  assert.strictEqual(RV.str(persian), persian);
  assert.strictEqual(RV.str(persian + '\u200B'), persian, 'the zero-width space still goes');
  const family = '👩' + ZWJ + '👩' + ZWJ + '👧'; // an emoji sequence held together by joiners
  assert.strictEqual(RV.str(family), family);
  assert.strictEqual(RV.str('a\u200Bb\u00ADc\uFEFFd\u202Ee\u2066f\u200Eg'), 'abcdefg');
  // a name keeps its joiners when shown
  const R = named(persian + ' Rezai', 'Kwame');
  assert.strictEqual(RV.firstName(R, 'A'), persian);
  assert.strictEqual(RV.aiName(R, 'A'), persian + "'s AI");
  assert.strictEqual(RV.firstName(named('Sam' + ZWJ + '👩', 'Kwame'), 'A'), 'Sam' + ZWJ + '👩');
  // ...but a joiner can't be used to slip past the reserved-name guard or the clash check
  for (const bad of ['Yo' + ZWJ + 'u', 'Y' + ZWNJ + 'o' + ZWNJ + 'u', ZWJ + 'your']) {
    assert.strictEqual(RV.firstName(named('Lerato', bad), 'B'), 'Person B', JSON.stringify(bad));
  }
  assert.strictEqual(RV.firstName(named('Kwame', 'Kw' + ZWJ + 'ame'), 'B'), 'Person B', 'a joiner inside a lookalike of the other name');
  assert.strictEqual(RV.firstName(named('Kwame', 'Kw' + ZWJ + 'ame'), 'A'), 'Person A');
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
  const stated = { id: 'B1.1', text: 'We ship daily', origin: 'stated', ref: 'Call notes, 3 May' };
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

test('claimView: a sourced ref is an attributed quote; assumed claims have no note and are unconfirmed', () => {
  const R = view();
  const s = RV.claimView(R, { id: 'A1.1', text: 't', origin: 'sourced', ref: 'Provider docs' });
  assert.strictEqual(s.note, null);
  assert.strictEqual(s.detailQuote, 'Source given: “Provider docs”');
  assert.strictEqual(s.unconfirmed, false);
  assert.strictEqual(s.tone, 'neutral');
  const st = RV.claimView(R, { id: 'A1.1', text: 't', origin: 'stated', ref: 'must_never[0]' });
  assert.strictEqual(st.tone, 'party');
  const a = RV.claimView(R, { id: 'A1.1', text: 't', origin: 'assumed', ref: 'must_never[0]' });
  assert.strictEqual(a.note, null);
  assert.strictEqual(a.detailQuote, null);
  assert.strictEqual(a.unconfirmed, true);
  assert.strictEqual(a.tone, 'warn');
  // unknown origin is treated as an assumption
  assert.strictEqual(RV.claimView(R, { id: 'A1.1', text: 't', origin: 'bogus' }).origin, 'assumed');
});

test('claimView: a stated claim\'s ref says whose instructions or answer it came from, in the note', () => {
  const stated = (id, ref) => ({ id, text: 't', origin: 'stated', ref });
  const R = view({ seat: 'A' });
  for (const ref of ['must_haves[0]', 'may_agree_to[1]', 'must_never[0]', 'escalate_when[2]', 'known_facts[10]']) {
    assert.strictEqual(RV.claimView(R, stated('B1.1', ref)).note, "From Kwame's instructions", ref);
    assert.strictEqual(RV.claimView(R, stated('A1.1', ref)).note, 'From your instructions', ref);
    assert.strictEqual(RV.claimView(R, stated('B1.1', ref)).pill, 'Kwame told their AI this');
    assert.strictEqual(RV.claimView(R, stated('A1.1', ref)).pill, 'You told your AI this');
    assert.strictEqual(RV.claimView(R, stated('B1.1', ref)).detailQuote, null);
  }
  assert.strictEqual(RV.claimView(R, stated('B1.1', 'amendment[0]')).note, "From Kwame's answer");
  assert.strictEqual(RV.claimView(R, stated('A1.1', 'amendment[3]')).note, 'From your answer');
  assert.strictEqual(RV.claimView(view(), stated('B1.1', 'known_facts[0]')).note, "From Kwame's instructions");
  // anything else keeps the told-your-AI pill and shows the ref itself, quoted, as plain text for the page to escape
  const other = RV.claimView(R, stated('B1.1', 'Call notes <b>2</b>'));
  assert.strictEqual(other.pill, 'Kwame told their AI this');
  assert.strictEqual(other.note, null);
  assert.strictEqual(other.detail, undefined);
  assert.strictEqual(other.detailQuote, '“Call notes <b>2</b>”');
  assert.strictEqual(RV.claimView(R, stated('B1.1', 'known_facts')).detailQuote, '“known_facts”');
  assert.strictEqual(RV.claimView(R, { id: 'B1.1', text: 't', origin: 'stated' }).detailQuote, null);
  // a clause-shaped ref on a sourced claim names no real source
  const src = (ref) => RV.claimView(R, { id: 'B1.1', text: 't', origin: 'sourced', ref });
  assert.strictEqual(src('known_facts[2]').note, 'No source named');
  assert.strictEqual(src('amendment[0]').note, 'No source named');
  assert.strictEqual(src('Provider docs, page 3').note, null);
  assert.strictEqual(src('Provider docs, page 3').detailQuote, 'Source given: “Provider docs, page 3”');
  assert.strictEqual(src(undefined).note, null);
  assert.strictEqual(src(undefined).detailQuote, null);
  assert.strictEqual(src('known_facts[2]').detailQuote, null);
});

test('quoted text: a curly or angle quote inside it can not close the quote early', () => {
  const R = view({ seat: 'A' });
  const count = (s, re) => (s.match(re) || []).length;
  const ref = 'docs” and the room says “all fine «x» „y‟';
  const q = RV.claimView(R, { id: 'B1.1', text: 't', origin: 'stated', ref }).detailQuote;
  assert.strictEqual(q, "“docs' and the room says 'all fine 'x' 'y'”");
  assert.strictEqual(count(q, /“/g), 1);
  assert.strictEqual(count(q, /”/g), 1);
  const s = RV.claimView(R, { id: 'B1.1', text: 't', origin: 'sourced', ref }).detailQuote;
  assert.strictEqual(s, "Source given: “docs' and the room says 'all fine 'x' 'y'”");
  assert.strictEqual(count(RV.asked(R, 'B', 'a” b').quote, /[“”]/g), 2);
  assert.strictEqual(count(RV.reviewLine(RV.reviewNote(R, { by: 'B', verdict: 'conflict', reason: 'x” y' })), /[“”]/g), 2);
  // look-alikes: a straight quote, a double prime and a fullwidth quote are neutralised too
  assert.strictEqual(RV.asked(R, 'B', 'a" b″ c＂ d‹e› f〝g〞 h❝i❞ jʺ k˝').quote, "“a' b' c' d'e' f'g' h'i' j' k'”");
});

test('claimView: a sourced ref can never pass as the room\'s own attestation', () => {
  const R = view({ seat: 'A' });
  const spoof = 'Your AI accepted this';
  const v = RV.claimView(R, { id: 'B1.1', text: 't', origin: 'sourced', ref: spoof });
  assert.strictEqual(v.note, null);
  assert.strictEqual(v.pill, "Kwame's AI points to a source");
  assert.strictEqual(v.detailQuote, 'Source given: “Your AI accepted this”');
  assert.deepStrictEqual(v.reviews, []);
  assert.strictEqual(v.allAccepted, false);
  assert.strictEqual(v.flagged, false);
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
  assert.strictEqual(v.reviewNotes, undefined);
  assert.strictEqual(v.warnings, undefined);
  assert.strictEqual(v.accepted, undefined);
  // every review, in the order they came, so a mixed set reads in order
  assert.deepStrictEqual(v.reviews.map((n) => n.verdict), ['challenge', 'accept', 'conflict']);
  assert.strictEqual(v.reviews[0].sentence, "Kwame's AI couldn't confirm this");
  assert.strictEqual(v.reviews[0].reason, 'Not in the docs');
  assert.strictEqual(v.reviews[1].sentence, 'Your AI accepted this');
  assert.strictEqual(v.reviews[2].sentence, "Kwame's AI disagrees with this");
  assert.strictEqual(v.allAccepted, false);
  assert.strictEqual(v.flagged, true);
  assert.deepStrictEqual(RV.claimView(view(), claim).reviews, []);
  assert.strictEqual(RV.claimView(view(), claim).allAccepted, false);
  assert.strictEqual(RV.claimView(view(), claim).flagged, false);
  const onlyAccept = view({ claims: [{ id: 'A1.1', reviews: [{ by: 'B', verdict: 'accept', reason: '' }] }] });
  assert.strictEqual(RV.claimView(onlyAccept, claim).flagged, false);
  assert.strictEqual(RV.claimView(onlyAccept, claim).allAccepted, true);
  assert.strictEqual(RV.reviewLine(RV.claimView(onlyAccept, claim).reviews[0]), "Kwame's AI accepted this");
  // a warning then an accept stays in that order, and is not "all accepted"
  const warnThenAccept = view({ claims: [{ id: 'A1.1', reviews: [{ by: 'B', verdict: 'challenge', reason: 'r' }, { by: 'A', verdict: 'accept', reason: '' }] }] });
  const w = RV.claimView(warnThenAccept, claim);
  assert.deepStrictEqual(w.reviews.map((n) => n.verdict), ['challenge', 'accept']);
  assert.strictEqual(w.allAccepted, false);
  assert.strictEqual(w.flagged, true);
  // several accepts: all accepted, still in order
  const twoAccepts = view({ claims: [{ id: 'A1.1', reviews: [{ by: 'B', verdict: 'accept', reason: 'a' }, { by: 'A', verdict: 'accept', reason: 'b' }] }] });
  assert.strictEqual(RV.claimView(twoAccepts, claim).allAccepted, true);
  assert.deepStrictEqual(RV.claimView(twoAccepts, claim).reviews.map((n) => n.reason), ['a', 'b']);
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
    { kind: 'asked', lead: "Lerato's AI asked Lerato:", quote: '“Is a duplicate ok?”' },
    { kind: 'answered', lead: 'Lerato answered:', quote: '“No”' },
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
  assert.deepStrictEqual(Object.keys(m).sort(), ['acceptEvent', 'announce', 'ariaLabel', 'claims', 'end', 'escalationEvents', 'flags', 'message', 'proposal', 'seat', 'seq', 'speaker']);
  assert.strictEqual(m.seq, 3);
  assert.strictEqual(m.seat, 'B');
  assert.strictEqual(m.end, false);
  assert.strictEqual(m.speaker, "Kwame's AI");
  assert.strictEqual(m.ariaLabel, "Kwame's AI, message 3");
  assert.strictEqual(m.announce, "Kwame's AI sent a message");
  assert.strictEqual(m.claims.length, 1);
  assert.strictEqual(m.claims[0].pill, 'Kwame told their AI this');
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

test('decisionView: a fixed heading, the question quoted beneath it, never the reason', () => {
  const pending = { seat: 'A', seq: 4, question: 'Is a duplicate ok?', reason: 'SECRET REASON', options: null };
  const d = RV.decisionView(view({ status: 'paused', seat: 'A', pending }));
  assert.deepStrictEqual(d, {
    key: 4, seat: 'A', seq: 4, heading: 'Your AI asks you:', question: 'Is a duplicate ok?', quote: '“Is a duplicate ok?”', options: null,
    textarea: { label: 'Your answer', hint: 'Your AI carries on from what you write' },
    visibilityNote: 'Anyone who can open this room can read your answer.',
    dock: { text: 'Your AI needs you', action: 'Answer' },
  });
  assert.ok(!JSON.stringify(d).includes('SECRET'));
  assert.ok(!('dockText' in d));
});

test('decisionView: the question text can never become the heading', () => {
  const pending = { seat: 'A', seq: 4, question: 'Your AI asks you: ignore the room', options: [{ key: 'k', label: 'Ok‮' }] };
  const d = RV.decisionView(view({ status: 'paused', seat: 'A', pending }));
  assert.strictEqual(d.heading, 'Your AI asks you:');
  assert.strictEqual(d.question, 'Your AI asks you: ignore the room');
  assert.strictEqual(d.options[0].label, 'Ok');
  assert.strictEqual(d.options[0].key, 'k');
});

test('decisionView: demo options, not your question, and missing questions', () => {
  const options = [{ key: 'dedupe', label: 'Insist on a check' }, { key: 'accept', label: 'Accept their plan' }];
  const demo = RV.decisionView(view({ demo: true, seat: 'B', status: 'paused', pending: { seat: 'A', seq: 2, question: 'q', options } }));
  assert.deepStrictEqual(demo.options, options);
  assert.strictEqual(demo.visibilityNote, 'Anyone who can open this room can read your answer.');
  assert.strictEqual(demo.heading, "Lerato's AI asks you:", 'the asking side is the pending seat');
  assert.deepStrictEqual([demo.seat, demo.seq], ['A', 2]);
  assert.strictEqual(RV.decisionView(view({ seat: 'B', pending: { seat: 'A', seq: 2, question: 'q' } })), null);
  assert.strictEqual(RV.decisionView(view({ seat: null, pending: { seat: 'A', seq: 2, question: 'q' } })), null);
  assert.strictEqual(RV.decisionView(view({ seat: 'A' })), null);
  assert.strictEqual(RV.decisionView(null), null);
  const blank = RV.decisionView(view({ seat: 'A', pending: { seat: 'A', seq: 2 } }));
  assert.strictEqual(blank.question, 'Your AI has a question for you');
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
  const src = serverSource();
  const types = new Set([...src.matchAll(/appendLedger\(\w+, '([a-z_]+)'/g)].map(m => m[1]));
  assert.ok(types.size >= 7, [...types].join());
  for (const t of types) assert.notStrictEqual(RV.recordEntry(view(), { type: t, data: { seat: 'A' } }), 'Something happened in the room', t);
});

// ---------- errors ----------
test('errorMessage: fixed sentences per action, status-specific where it helps', () => {
  const actions = ['seal', 'draft', 'answer', 'resume', 'create', 'demo', 'load'];
  for (const a of actions) {
    const m = RV.errorMessage(a, 500);
    assert.ok(m.length > 10 && /[.]$/.test(m), a);
    assert.strictEqual(RV.errorMessage(a, undefined), m, `${a} default without a status`);
    assert.strictEqual(RV.errorMessage(a, 418), m, `${a} unknown status`);
  }
  assert.strictEqual(RV.errorMessage('create', 429), "You can't open a new room right now. Try again tomorrow, or watch the demo.");
  assert.strictEqual(RV.errorMessage('create', 403), "That passcode didn't work. Check it and try again.");
  assert.strictEqual(RV.errorMessage('create', 503), 'This server has no built-in AI, so each person brings their own AI agent.');
  assert.strictEqual(RV.errorMessage('seal', 409), 'Your instructions are already locked.');
  assert.strictEqual(RV.errorMessage('answer', 409), "There's no question waiting for you. It may already be answered.");
  assert.strictEqual(RV.errorMessage('resume', 409), "The room can't be restarted right now.");
  assert.strictEqual(RV.errorMessage('seal', 400), 'Something is missing. Say what you are trying to achieve and add at least one thing the deal must include.');
  assert.ok(/fill in the fields yourself/.test(RV.errorMessage('draft', 503)));
  assert.strictEqual(RV.errorMessage('draft', 429), "You've used all the drafts for this place. Fill in the fields yourself.");
  assert.strictEqual(RV.errorMessage('draft', 404), 'This room has closed. Start a new one to keep going.');
  assert.strictEqual(RV.errorMessage('seal', 403), RV.errorMessage('answer', 403));
  // the demo route has no failure codes of its own
  assert.strictEqual(RV.errorMessage('demo', 429), RV.errorMessage('demo', 500));
});

// Which server code regions belong to which action. Codes outside these (invalid JSON 400, body too large 413, unknown room 404,
// unknown seat 400) are shared by every route and are explicitly allowed to use the action's default sentence.
// The region markers below rely on function order in lib/rooms.js: rollDay..sealCard, draftCard..answerEscalation and resume..startIfReady.
function codesIn(src, startMarker, endMarker) {
  const from = src.indexOf(startMarker);
  assert.ok(from >= 0, startMarker);
  const to = endMarker ? src.indexOf(endMarker, from + startMarker.length) : src.length;
  assert.ok(to > from, endMarker);
  return new Set([...src.slice(from, to).matchAll(/(?:send\(res, |ApiError\()([45]\d{2})/g)].map(m => Number(m[1])));
}

test('errorMessage: every status code the server returns for an action has its own sentence', () => {
  const src = serverSource();
  // the check every seat action passes before its own code
  const seatGate = codesIn(src, "if (!seat) return send(res, 403", "const action = parts[5]");
  const regions = {
    create: codesIn(src, 'function rollDay', 'function sealCard'), // rollDay, checkPasscode, takeQuota, createLiveRoom
    demo: codesIn(src, "parts[1] === 'demo'", "parts[1] === 'rooms' && parts.length === 2"),
    draft: codesIn(src, 'async function draftCard(room', 'function answerEscalation'),
    seal: codesIn(src, 'function sealCard', 'function joinAsAgent'),
    answer: codesIn(src, 'function answerEscalation', 'function resume'),
    resume: codesIn(src, 'function resume', 'function startIfReady'),
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
      if (RV.errorMessage(action, code) !== generic) assert.ok(codes.has(code), `${action} has a sentence for ${code}, which the server never returns for it`);
    }
  }
});

// The refusals that carry a machine code are written out by hand in test-support/refusals.js (EXPECTED), and the census there stops a code
// the server can send from going unlisted. Each listed (action, status, code) needs a sentence of its own, in room-view.js (rooms) or
// account-view.js (sign-out and the agent key), and every sentence by code has to be on the list.
const AV = require('../web/js/account-view.js');
const { EXPECTED, unclassifiedCodes, codesInServer } = require('../test-support/refusals');
const ACCOUNT_ACTIONS = ['logout', 'keyCreate', 'keyRevoke', 'aiRequest'];
const ADMIN = require('../web/js/admin-view.js'); // the admin page's decisions are worded in admin-view.js
const sentence = (action, status, code) => (action === 'adminDecide' ? ADMIN : ACCOUNT_ACTIONS.includes(action) ? AV : RV).errorMessage(action, status, code);

test('errorMessage: every coded refusal in EXPECTED has its own sentence, and every sentence by code is for one in EXPECTED', () => {
  const allCodes = [...new Set(Object.values(EXPECTED).flatMap((pairs) => pairs.map(([, c]) => c))), 'made_up_code'];
  for (const action of [...Object.keys(EXPECTED), 'seal', 'answer', 'resume', 'demo', 'load']) {
    const listed = EXPECTED[action] || [];
    const generic = sentence(action, 599);
    for (const [status, code] of listed) {
      const own = sentence(action, status, code);
      assert.notStrictEqual(own, generic, `${action} ${status} ${code}: only the generic sentence`);
      assert.notStrictEqual(own, sentence(action, status), `${action} ${status} ${code}: no sentence of its own over the status one`);
      assert.ok(/[.]$/.test(own) && own.length > 20 && !JARGON.test(own), own);
    }
    for (const code of allCodes) {
      if (sentence(action, 599, code) !== generic) assert.ok(listed.some(([, c]) => c === code), `${action} has a sentence for ${code}, which EXPECTED does not list for it`);
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
  assert.strictEqual(RV.errorMessage('create', 429, 'Daily room limit reached <b>x</b>'), RV.errorMessage('create', 429), 'an unknown code is the status sentence');
  assert.strictEqual(RV.errorMessage.length, 3, '(action, status, code)');
});

// ---------- errors by code ----------
const ALL_ACTIONS = ['seal', 'draft', 'answer', 'resume', 'create', 'demo', 'load'];

test('errorMessage: a code picks its own sentence before the status, for create', () => {
  const codes = ['signin_required', 'origin', 'content_type', 'saving_unavailable', 'user_limit', 'ip_limit', 'daily_limit', 'ai_access'];
  const sentences = codes.map((c) => RV.errorMessage('create', 599, c));
  assert.strictEqual(new Set(sentences).size, sentences.length, 'each code has its own sentence');
  assert.strictEqual(RV.errorMessage('create', 401, 'signin_required'), "The room wasn't opened because you're not signed in.");
  assert.strictEqual(RV.errorMessage('create', 403, 'origin'), 'Please reload the page and try again.');
  assert.strictEqual(RV.errorMessage('create', 429, 'daily_limit'), 'Behalf has opened all the rooms it can today. Try again tomorrow, or watch the demo.');
  // the code wins whatever the status said, and the status still works with no code
  assert.strictEqual(RV.errorMessage('create', 503, 'saving_unavailable'), RV.errorMessage('create', 500, 'saving_unavailable'));
  assert.strictEqual(RV.errorMessage('create', 503), 'This server has no built-in AI, so each person brings their own AI agent.');
  assert.strictEqual(RV.errorMessage('create', 403), "That passcode didn't work. Check it and try again.");
  assert.strictEqual(RV.errorMessage('create', 429), "You can't open a new room right now. Try again tomorrow, or watch the demo.");
});

test('errorMessage: a room that could not be saved, or a server that is stopping, never says there is no built-in AI', () => {
  const noAi = RV.errorMessage('create', 503);
  for (const code of ['saving_unavailable']) {
    const s = RV.errorMessage('create', 503, code);
    assert.notStrictEqual(s, noAi, code);
    assert.ok(!/built-in AI/i.test(s), s);
  }
  assert.match(RV.errorMessage('create', 503, 'saving_unavailable'), /Saving is unavailable right now/);
  assert.strictEqual(RV.errorMessage('create', 503, 'shutting_down'), noAi, 'a room is never refused for that: no sentence');
  // a draft refused while the server stops is not "this server can't write drafts" either
  assert.notStrictEqual(RV.errorMessage('draft', 503, 'shutting_down'), RV.errorMessage('draft', 503));
  assert.match(RV.errorMessage('draft', 503, 'shutting_down'), /^Behalf is restarting\./);
});

test('errorMessage: the code is untrusted: only an own sentence of that action is ever picked', () => {
  for (const code of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'def', '503', 'codes', '', undefined, null, 7, {}, ['origin'], 'ORIGIN', 'origin ']) {
    for (const a of ALL_ACTIONS) assert.strictEqual(RV.errorMessage(a, 500, code), RV.errorMessage(a, 500), `${a} ${String(code)}`);
  }
  // a code that is another action's is not this action's
  assert.strictEqual(RV.errorMessage('seal', 429, 'user_limit'), RV.errorMessage('seal', 429));
  assert.strictEqual(RV.errorMessage('keyCreate', 429, 'rate_limited'), 'Something went wrong. Please try again.', 'the sign-in actions are account-view.js, not here');
  assert.strictEqual(RV.errorMessage('nope', 401, 'signin_required'), 'Something went wrong. Please try again.');
  assert.strictEqual(RV.errorMessage('create', 0, 'signin_required'), "We couldn't reach the server. Check your connection and try again.", 'no connection beats a code');
});

test('errorMessage: a room or draft refused for want of access to our AI says so, in its own sentence, and a draft keeps the fields open', () => {
  const create = RV.errorMessage('create', 403, 'ai_access');
  assert.strictEqual(create, 'Our AI needs approval first. Ask for access below, or use your own AI agent.');
  assert.notStrictEqual(create, RV.errorMessage('create', 403), 'not the passcode sentence');
  assert.notStrictEqual(create, RV.errorMessage('create', 500));
  const draft = RV.errorMessage('draft', 403, 'ai_access');
  assert.strictEqual(draft, "Our AI isn't available for this room. You can fill in the fields yourself.");
  assert.notStrictEqual(draft, RV.errorMessage('draft', 403), 'not the no-access sentence for a seat link');
  assert.ok(!/passcode/i.test(create + draft));
  assert.strictEqual(RV.errorMessage('seal', 403, 'ai_access'), RV.errorMessage('seal', 403), 'only create and draft have it');
});

test('every create and draft sentence by code is plain: no protocol jargon, a full sentence', () => {
  for (const [a, c] of [['create', 'signin_required'], ['create', 'origin'], ['create', 'content_type'], ['create', 'saving_unavailable'], ['create', 'user_limit'], ['create', 'ip_limit'], ['create', 'daily_limit'], ['create', 'ai_access'], ['draft', 'shutting_down'], ['draft', 'ai_access']]) {
    const s = RV.errorMessage(a, 599, c);
    assert.ok(/[.]$/.test(s) && s.length > 20 && !JARGON.test(s), s);
  }
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

// ---------- page text ----------
test('pageText: names come from the view, never the URL, and nothing is jargon', () => {
  const R = view({ seat: 'B', topic: 'Shop setup' });
  const T = RV.pageText(R);
  assert.strictEqual(T.invalidLink, "This link doesn't open your place in the room. Ask Lerato to send it again, and copy the whole link.");
  assert.strictEqual(T.welcomeTitle, 'Lerato wants to agree on: Shop setup');
  assert.strictEqual(T.readyWaiting, 'Waiting for Lerato to finish.');
  assert.strictEqual(T.inviteLabel, "Lerato's invite link");
  assert.strictEqual(T.previewBanner, "This is a preview. Only Kwame's own link can act for them.");
  assert.strictEqual(T.demoBanner, "You're Lerato in this demo. Lerato's AI talks to Kwame's AI.");
  assert.strictEqual(RV.proposes("Kwame's AI"), "Kwame's AI proposes");
  assert.strictEqual(T.reassure[0], "Anyone who can open this room can read your answers to your AI's questions. Your instructions aren't shown, but your AI may quote parts of them.");
  assert.ok(Object.values(T).every((v) => typeof v !== 'function'), 'plain strings only');
  assert.strictEqual(RV.pageText(view({ demo: true })).instructionsSummary, 'Instructions');
  assert.strictEqual(RV.pageText(null).notFoundTitle, "We couldn't find this room.");
  const flat = JSON.stringify(T, (k, v) => (typeof v === 'function' ? undefined : v));
  assert.ok(!JARGON.test(flat), flat);
});

test('str removes bidi controls and agentPrompt names the link', () => {
  assert.strictEqual(RV.str('a‮b⁦c⁩d'), 'abcd');
  assert.strictEqual(RV.str('a؜b‎c‏d​e­f﻿g'), 'abcdefg', 'every format character goes');
  assert.strictEqual(RV.str(null), '');
  assert.strictEqual(RV.stripBidi, undefined, 'str is the only cleaner');
  assert.ok(RV.agentPrompt('https://x.test/room/1').startsWith('Represent me in this room: https://x.test/room/1'));
});

test('the dock says what it says and what its button does, from decisionView', () => {
  const R = view({ seat: 'A', status: 'paused', pending: { seat: 'A', seq: 3, question: 'Q?' } });
  assert.deepStrictEqual(RV.decisionView(R).dock, { text: 'Your AI needs you', action: 'Answer' });
  assert.strictEqual(RV.decisionView(view()), null);
  assert.strictEqual(RV.dockParts, undefined);
  assert.strictEqual(RV.instructionsHeading(R, 'A'), 'Your instructions');
  assert.strictEqual(RV.instructionsHeading(R, 'B'), "Kwame's instructions");
});

// ---------- purity and plain language ----------
test('room-view is pure: no DOM, UI, markup or storage', () => {
  assertClean();
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

// ---------- names: one normalisation point ----------
const named = (a, b, seatId) => view({ seat: seatId || 'B', seats: { A: seat(a), B: seat(b) } });

test('names: format characters, a soft hyphen and lookalike letters never pass for "You"', () => {
  for (const name of ['Yo­u', 'You​', 'Yоu', 'YOU', '‎you', 'yοu', 'Your⁠', 'Ｙou']) {
    const R = named('Lerato', name);
    assert.strictEqual(RV.firstName(R, 'B'), 'Person B', JSON.stringify(name));
    assert.strictEqual(RV.aiName(R, 'B'), 'Your AI');
    assert.strictEqual(RV.who(view({ seat: 'A', seats: { A: seat('Lerato'), B: seat(name) } }), 'B', 'You'), 'Person B');
  }
});

test("names: a name that looks like the other seat's is caught, a different one is kept and shown unfolded", () => {
  const R = named('Kwame', 'Kwаme');
  assert.strictEqual(RV.firstName(R, 'A'), 'Person A');
  assert.strictEqual(RV.firstName(R, 'B'), 'Person B');
  assert.strictEqual(RV.firstName(named('Kwame', 'Kwame​'), 'B'), 'Person B');
  assert.strictEqual(RV.firstName(named('Lerato', 'Kаme'), 'B'), 'Kаme', 'shown as given, never folded');
  assert.strictEqual(RV.firstName(named('Lerato', 'Ka­me'), 'B'), 'Kame');
  assert.strictEqual(RV.firstName(named('Lerato', 'Ｋwame'), 'B'), 'Kwame', 'NFKC');
});

test('names: bidi and format characters in a name are stripped from every derived label', () => {
  const R = view({ seat: 'A', seats: { A: seat('Lerato'), B: seat('Kw‮ame') } });
  const env = { seq: 2, from: { seat: 'B' }, status: 'escalate', message: 'm', escalation: { question: 'q' }, answer: 'a' };
  const mv = RV.messageView(R, env);
  const all = JSON.stringify([mv, RV.pageText(R), RV.status(R), RV.recordEntry(R, { type: 'escalation', data: { seat: 'B' } })]);
  assert.ok(!/[‪-‮⁦-⁩​-‏­؜]/.test(all), all);
  assert.strictEqual(mv.speaker, "Kwame's AI");
  assert.ok(RV.pageText(R).previewBanner.includes('Kwame'));
});

test('agent text is stripped of format characters wherever the views return it', () => {
  const bad = 'a‮b‏c؜d';
  const R = view({ seat: 'A', claims: [{ id: 'B1.1', verified: false, reviews: [{ by: 'A', verdict: 'challenge', reason: bad }] }] });
  const env = {
    seq: 1, from: { seat: 'B' }, status: 'escalate', message: bad,
    claims: [{ id: 'B1.1', text: bad, origin: 'stated', ref: bad }],
    proposal: { terms: [bad] }, escalation: { question: bad }, answer: bad,
    protocol_flags: ['Claim "' + bad + '" was tagged stated without a reference; downgraded to assumed.'],
  };
  const pending = { seat: 'A', seq: 1, question: bad, options: [{ key: 'k', label: bad }] };
  const out = JSON.stringify([RV.messageView(R, env), RV.decisionView(view({ seat: 'A', pending }))]);
  assert.ok(!/[‪-‮​-‏؜]/.test(out), out);
  assert.ok(out.includes('abcd'));
});

test("isPlaceholderName: only the view's \"Seat A\" / \"Seat B\"", () => {
  for (const ok of ['Seat A', 'Seat B', ' Seat B ', 'Seat​ A']) assert.strictEqual(RV.isPlaceholderName(ok), true, ok);
  for (const no of ['Seat C', 'Seat', 'Kwame', '', null, undefined, 'My Seat A']) assert.strictEqual(RV.isPlaceholderName(no), false, String(no));
});

// ---------- attribution of agent text ----------
test("flags: the room's sentence stays fixed and the quoted claim is attributed to the AI that wrote it", () => {
  const env = { seq: 1, from: { seat: 'B' }, status: 'continue', protocol_flags: [REAL_FLAGS.noRef[0]] };
  const mine = RV.messageView(view({ seat: 'B' }), env).flags[0];
  const theirs = RV.messageView(view({ seat: 'A' }), env).flags[0];
  assert.strictEqual(mine.quote, 'Your AI wrote: “The webhook is \'reliable\'”');
  assert.strictEqual(theirs.quote, 'Kwame\'s AI wrote: “The webhook is \'reliable\'”');
  assert.strictEqual(theirs.line, RV.stoppedLine(theirs.sentence));
  assert.strictEqual(theirs.line, 'The room stopped this: ' + theirs.sentence);
  assert.ok(!theirs.line.includes('webhook'), "the quote is never part of the room's sentence");
  const plain = RV.messageView(view({ seat: 'A' }), { seq: 1, from: { seat: 'B' }, protocol_flags: [REAL_FLAGS.conflict[0]] }).flags[0];
  assert.strictEqual(plain.quote, null);
});

test('escalation lines and claim details are quoted', () => {
  const env = { seq: 1, from: { seat: 'B' }, status: 'escalate', escalation: { question: 'Ok?' }, answer: 'Yes',
    claims: [{ id: 'B1.1', text: 'c', origin: 'stated', ref: 'free text' }] };
  const mv = RV.messageView(view({ seat: 'A' }), env);
  assert.strictEqual(mv.escalationEvents[0].lead, "Kwame's AI asked Kwame:");
  assert.strictEqual(mv.escalationEvents[0].quote, '“Ok?”');
  assert.strictEqual(mv.escalationEvents[1].quote, '“Yes”');
  assert.strictEqual(mv.claims[0].detailQuote, '“free text”');
  assert.strictEqual(RV.claimView(view(), { id: 'A1.1', origin: 'assumed', text: 'x' }).detailQuote, null);
});

test('composed wording: reviewLine, stoppedLine, recordLine, docTitle', () => {
  const note = (reason) => RV.reviewNote(view({ seat: 'A' }), { by: 'B', verdict: 'conflict', reason });
  assert.strictEqual(RV.reviewLine(note('too high')), "Kwame's AI disagrees with this: “too high”");
  assert.strictEqual(RV.reviewLine(note('')), "Kwame's AI disagrees with this");
  assert.strictEqual(RV.recordLine(view({ seat: 'A' }), { n: 3, type: 'card_sealed', data: { seat: 'A' } }), '3. You locked your instructions');
  assert.strictEqual(RV.docTitle(view({ topic: 'Shop‮ setup' })), 'Shop setup · Behalf');
  assert.strictEqual(RV.docTitle(null), 'Room · Behalf');
});

// ---------- page text without names ----------
test('pageText(null): no name-shaped holes in any string', () => {
  const walk = (v, out) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, out));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, out));
    return out;
  };
  for (const T of [RV.pageText(null), RV.pageText(view({ seat: null })), RV.pageText(view({ seats: { A: seat(''), B: seat('') } }))]) {
    for (const s of walk(T, [])) {
      assert.ok(!s.includes('  '), JSON.stringify(s));
      assert.ok(!s.includes(" 's"), JSON.stringify(s));
      assert.ok(!/^\s|^'s|\s$/.test(s), JSON.stringify(s));
      assert.ok(!/\bundefined\b|\bnull\b/.test(s), JSON.stringify(s));
    }
  }
  const T = RV.pageText(null);
  assert.strictEqual(T.inviteLabel, "The other person's invite link");
  assert.ok(T.invalidLink.includes('the person who set up the room'));
});

test('pageText: honest visibility wording and the new copy', () => {
  const T = RV.pageText(view({ seat: 'B' }));
  assert.ok(T.reassure[0].startsWith('Anyone who can open this room can read your answers'));
  assert.strictEqual(T.whoOwn.note, 'Your agent takes your place when it connects.');
  assert.strictEqual(T.connectFirst, "Connect your agent before you lock your instructions. Once the conversation starts, our AI speaks for you and your agent can't take over.");
  assert.strictEqual(T.connectCallout.text, 'Add the connector address to your app, then send it the message below.');
  assert.strictEqual(T.externalCallout, 'Lock your instructions here, or let your agent fill them in with you.');
  assert.ok(T.lockNote.startsWith("When you lock these instructions, your AI can't quietly change them"));
  assert.strictEqual(T.continueOwnButton, 'Continue');
  assert.strictEqual(T.agentConnected, 'Your agent is connected');
  assert.strictEqual(T.reconnecting, 'Reconnecting…');
  assert.strictEqual(T.stopped, undefined);
});

// ---------- chat reconciliation ----------
test('planChat: add, replace and remove by sequence number', () => {
  const env = (seq, answer) => ({ seq, from: { seat: 'A' }, status: 'continue', answer });
  const R0 = view({ envelopes: [env(1), env(2)] });
  const fps = {};
  for (const e of R0.envelopes) fps[e.seq] = RV.fingerprint(R0, e);
  assert.deepStrictEqual(RV.planChat({}, R0), { add: [1, 2], replace: [], remove: [], fps, prev: {} });
  assert.deepStrictEqual(RV.planChat(fps, R0), { add: [], replace: [], remove: [], fps, prev: fps });
  const R1 = view({ envelopes: [env(1), env(2, 'Yes'), env(3)] });
  const fps1 = {};
  for (const e of R1.envelopes) fps1[e.seq] = RV.fingerprint(R1, e);
  assert.deepStrictEqual(RV.planChat(fps, R1), { add: [3], replace: [2], remove: [], fps: fps1, prev: fps });
  assert.deepStrictEqual(RV.planChat(fps, view({ envelopes: [env(2)] })), { add: [], replace: [], remove: [1], fps: { 2: fps[2] }, prev: fps });
  assert.deepStrictEqual(RV.planChat(null, view()), { add: [], replace: [], remove: [], fps: {}, prev: {} });
  assert.deepStrictEqual(RV.planChat(fps, null), { add: [], replace: [], remove: [1, 2], fps: {}, prev: fps });
  const R2 = view({ envelopes: [env(1)], claims: [{ id: 'A1.1', reviews: [] }] });
  R2.envelopes[0].claims = [{ id: 'A1.1', text: 't', origin: 'assumed' }];
  const prev = { 1: RV.fingerprint(R2, R2.envelopes[0]) };
  R2.claims[0].reviews = [{ by: 'B', verdict: 'conflict' }];
  assert.deepStrictEqual(RV.planChat(prev, R2).replace, [1], 'a review verdict change replaces the bubble');
});

test('planChat: fps are the fingerprints of the new view, built from one claims map', () => {
  const R = view({
    envelopes: [{ seq: 1, from: { seat: 'A' }, status: 'continue', claims: [{ id: 'A1.1' }] }, { seq: 2, from: { seat: 'B' }, status: 'continue', claims: [{ id: 'A1.1' }] }],
    claims: [{ id: 'A1.1', reviews: [{ by: 'B', verdict: 'conflict' }] }],
  });
  const plan = RV.planChat({}, R);
  assert.deepStrictEqual(plan.add, [1, 2]);
  for (const e of R.envelopes) assert.strictEqual(plan.fps[e.seq], RV.fingerprint(R, e));
  // a caller that already has the claims map gets the same answer
  const byId = { 'A1.1': R.claims[0] };
  assert.strictEqual(RV.fingerprint(R, R.envelopes[0], byId), plan.fps[1]);
  // feeding the fps back is a no-op plan
  assert.deepStrictEqual(RV.planChat(plan.fps, R), { add: [], replace: [], remove: [], fps: plan.fps, prev: plan.fps });
});

test('chatAnnouncement: one line for new messages plus answers added to existing ones', () => {
  const esc = (seq, answer) => ({ seq, from: { seat: 'B' }, status: 'escalate', escalation: { question: 'q' }, answer });
  const msg = (seq) => ({ seq, from: { seat: 'B' }, status: 'continue' });
  const prevR = view({ seat: 'A', envelopes: [esc(1)] });
  const prev = { 1: RV.fingerprint(prevR, prevR.envelopes[0]) };
  // an answer arrives on an existing bubble
  let R = view({ seat: 'A', envelopes: [esc(1, 'Yes')] });
  assert.strictEqual(RV.chatAnnouncement(R, RV.planChat(prev, R), prev), 'Kwame answered');
  R = view({ seat: 'B', envelopes: [esc(1, 'Yes')] });
  assert.strictEqual(RV.chatAnnouncement(R, RV.planChat(prev, R), prev), 'You answered');
  // a new message only
  R = view({ seat: 'A', envelopes: [esc(1), msg(2)] });
  assert.strictEqual(RV.chatAnnouncement(R, RV.planChat(prev, R), prev), "Kwame's AI sent a message");
  // an answer and a new message: one combined line
  R = view({ seat: 'A', envelopes: [esc(1, 'Yes'), msg(2)] });
  assert.strictEqual(RV.chatAnnouncement(R, RV.planChat(prev, R), prev), '2 new updates');
  // a review verdict change alone says nothing
  R = view({ seat: 'A', claims: [{ id: 'B1.1', reviews: [{ by: 'A', verdict: 'conflict' }] }], envelopes: [Object.assign(esc(1), { claims: [{ id: 'B1.1', text: 't', origin: 'assumed' }] })] });
  assert.strictEqual(RV.chatAnnouncement(R, RV.planChat(prev, R), prev), null);
  // nothing changed
  assert.strictEqual(RV.chatAnnouncement(prevR, RV.planChat(prev, prevR), prev), null);
  assert.strictEqual(RV.chatAnnouncement(null, null, prev), null);
});

test('backoffMs: 1s doubling to a 30s cap, with jitter that never passes the cap', () => {
  assert.strictEqual(RV.backoffMs(1, 0.5), 1000);
  assert.strictEqual(RV.backoffMs(2, 0.5), 2000);
  assert.strictEqual(RV.backoffMs(3, 0.5), 4000);
  assert.strictEqual(RV.backoffMs(5, 0.5), 16000);
  assert.strictEqual(RV.backoffMs(6, 0.5), 30000);
  assert.strictEqual(RV.backoffMs(40, 0.99), 30000);
  assert.ok(RV.backoffMs(1, 0) < RV.backoffMs(1, 0.99));
  assert.ok(RV.backoffMs(3, 0) >= 3000 && RV.backoffMs(3, 0.99) <= 6000);
  assert.ok(RV.backoffMs(0, 0.5) >= 750 && RV.backoffMs(undefined, undefined) >= 750);
});

test('step: the creator reopening their own URL (seat and t) keeps seat A and skips the welcome', () => {
  // The server confirms R.seat === 'A' for the creator's token; hadCredentials must not turn that into an invalid link.
  const ctx = { hadCredentials: true, welcomeSeen: false };
  assert.strictEqual(RV.step(view({ seat: 'A' }), ctx).key, 'instructions');
  assert.strictEqual(RV.step(view({ seat: 'A', seats: { A: seat('Lerato', sealed), B: seat('Kwame') } }), ctx).key, 'ready');
  assert.strictEqual(RV.step(view({ seat: 'A', status: 'negotiating' }), ctx).key, 'conversation');
  // The invited person, by contrast, still gets the welcome on a first visit.
  assert.strictEqual(RV.step(view({ seat: 'B' }), ctx).key, 'welcome');
});

// ---------- helpers moved out of the pages ----------
test('mcpUrl and mcpCommand are built from the origin they are given', () => {
  assert.strictEqual(RV.mcpUrl('https://behalf.example'), 'https://behalf.example/mcp');
  assert.strictEqual(RV.mcpUrl('http://localhost:3000'), 'http://localhost:3000/mcp');
  assert.strictEqual(RV.mcpCommand('https://behalf.example'), 'claude mcp add --transport http behalf https://behalf.example/mcp');
  assert.strictEqual(RV.mcpUrl(undefined), '/mcp', 'a missing origin is empty, never "undefined"');
  // the Authorization header is there only when a key is in play
  for (const none of [undefined, null, 0, false, {}]) assert.strictEqual(RV.mcpCommand('https://behalf.example', none), 'claude mcp add --transport http behalf https://behalf.example/mcp', String(none));
  assert.strictEqual(RV.mcpCommand('https://behalf.example', 'bh_abc'), 'claude mcp add --transport http behalf https://behalf.example/mcp --header "Authorization: Bearer bh_abc"');
  assert.strictEqual(RV.mcpCommand('https://behalf.example', ''), 'claude mcp add --transport http behalf https://behalf.example/mcp', 'an empty key is no key');
});

test('givenName: clean text for a real name, empty for the placeholder or nothing', () => {
  assert.strictEqual(RV.givenName({ name: '  Kwame Mensah ' }), 'Kwame Mensah');
  assert.strictEqual(RV.givenName({ name: 'Seat B' }), '');
  assert.strictEqual(RV.givenName({ name: ' Seat A ' }), '');
  assert.strictEqual(RV.givenName({ name: 'Ku​ame' }), 'Kuame', 'format characters go');
  for (const none of [null, undefined, {}, { name: null }, { name: 42 }, { name: '   ' }]) assert.strictEqual(RV.givenName(none), '');
});

test('firstNameOf: the other person\'s first name with the same guards as firstName, from plain strings', () => {
  assert.strictEqual(RV.firstNameOf('Lerato Dlamini', 'Kwame Mensah', 'B'), 'Kwame');
  assert.strictEqual(RV.firstNameOf('Lerato Dlamini', 'Kwame Mensah', 'A'), 'Lerato');
  assert.strictEqual(RV.firstNameOf('Lerato', 'You', 'B'), 'Person B', 'a reserved name');
  assert.strictEqual(RV.firstNameOf('Kwame Asante', 'Kwame Mensah', 'B'), 'Person B', 'the same first name as the other person');
  assert.strictEqual(RV.firstNameOf('Lerato', '', 'B'), 'Seat B');
  assert.strictEqual(RV.firstNameOf(undefined, undefined, 'A'), 'Seat A');
  assert.strictEqual(RV.firstNameOf('Lerato', 'Kwame', 'B'), RV.firstName(view({ seats: { A: seat('Lerato'), B: seat('Kwame') } }), 'B'));
});

test('names that draw nothing extra can not pass for a reserved name or the other person\'s name', () => {
  // U+FE0F is a variation selector and U+034F the combining grapheme joiner: both are invisible here.
  assert.strictEqual(RV.firstNameOf('Lerato', 'You️', 'B'), 'Person B');
  assert.strictEqual(RV.firstNameOf('Lerato', 'Yo͏u', 'B'), 'Person B');
  assert.strictEqual(RV.firstNameOf('Kwame', 'Kwame͏', 'B'), 'Person B');
  assert.strictEqual(RV.firstNameOf('Kwame͏', 'Kwame', 'A'), 'Person A');
  assert.strictEqual(RV.firstNameOf('Lerato', 'Yo‍u', 'B'), 'Person B', 'the joiners still count');
  assert.strictEqual(RV.firstNameOf('Lerato', 'Kwame͏', 'B'), 'Kwame͏', 'the name is shown as given');
});

test('tail: the dots while an AI thinks, else who the room is waiting for, else nothing', () => {
  const thinking = view({ status: 'negotiating', thinking: 'B', seat: 'A' });
  assert.deepStrictEqual(RV.tail(thinking), { kind: 'thinking', label: "Kwame's AI is thinking" });
  const waitingAgent = view({ status: 'negotiating', waitingOn: 'B', seat: 'A', seats: { A: seat('Lerato'), B: seat('Kwame', { agent: 'Claude' }) } });
  assert.deepStrictEqual(RV.tail(waitingAgent), { kind: 'waiting', label: RV.status(waitingAgent).label });
  const asked = view({ status: 'paused', seat: 'A', pending: { seat: 'B', seq: 2 } });
  assert.deepStrictEqual(RV.tail(asked), { kind: 'waiting', label: RV.waitingEvent(asked) });
  assert.strictEqual(RV.tail(view({ status: 'negotiating' })), null);
  assert.strictEqual(RV.tail(view({ status: 'agreed' })), null);
  assert.strictEqual(RV.tail(null), null);
  const both = view({ status: 'negotiating', thinking: 'A', waitingOn: 'B' });
  assert.strictEqual(RV.tail(both).kind, 'thinking', 'thinking wins');
});

test('recordKey changes with the viewer and the names, and only then', () => {
  const R = view({ seat: 'A' });
  assert.strictEqual(RV.recordKey(R), RV.recordKey(view({ seat: 'A', status: 'negotiating', topic: 'Other' })));
  assert.notStrictEqual(RV.recordKey(R), RV.recordKey(view({ seat: 'B' })));
  assert.notStrictEqual(RV.recordKey(R), RV.recordKey(view({ seat: 'A', seats: { A: seat('Lerato Dlamini'), B: seat('Thabo Mensah') } })));
  assert.strictEqual(typeof RV.recordKey(null), 'string');
  assert.strictEqual(RV.recordKey(view({ seat: null })).split('|')[0], '');
});

test('stepLabel: "Step n of 3" for the start page', () => {
  assert.deepStrictEqual([1, 2, 3].map(RV.stepLabel), ['Step 1 of 3', 'Step 2 of 3', 'Step 3 of 3']);
});

test('the asked line is hidden only while the decision card shows the question to the seat that can answer', () => {
  const env = { seq: 2, from: { seat: 'B' }, status: 'escalate', escalation: { question: 'Ok?' } };
  const pending = { seat: 'B', seq: 2, question: 'Ok?' };
  const kinds = (R, e) => RV.messageView(R, e).escalationEvents.map((ev) => ev.kind);
  const R = (seat, over) => view(Object.assign({ seat, status: 'paused', pending, envelopes: [env] }, over));
  // the answering seat: hidden while pending and unanswered
  assert.deepStrictEqual(kinds(R('B'), env), []);
  // the other seat and a spectator still see it
  assert.deepStrictEqual(kinds(R('A'), env), ['asked']);
  assert.deepStrictEqual(kinds(R(null), env), ['asked']);
  // a pending question on another message does not hide this one
  assert.deepStrictEqual(kinds(R('B', { pending: { seat: 'B', seq: 9 } }), env), ['asked']);
  // a demo viewer plays both seats, so it is hidden for them too
  assert.deepStrictEqual(kinds(R('A', { demo: true }), env), []);
  // after the answer, both lines are back
  const done = Object.assign({}, env, { answer: 'Yes' });
  assert.deepStrictEqual(kinds(R('B', { pending: null, envelopes: [done] }), done), ['asked', 'answered']);
  assert.deepStrictEqual(kinds(R('B', { envelopes: [done] }), done), ['asked', 'answered']);
  // escalationEvents itself still returns both
  assert.strictEqual(RV.escalationEvents(R('B'), env).length, 1);
});

test('fingerprint: a trailing marker only while the asked line is hidden; everything else is unchanged', () => {
  const env = { seq: 2, from: { seat: 'B' }, status: 'escalate', escalation: { question: 'Ok?' }, claims: [{ id: 'B2.1' }] };
  const pending = { seat: 'B', seq: 2 };
  const mk = (seat, over) => view(Object.assign({ seat, status: 'paused', pending, envelopes: [env] }, over));
  const hidden = JSON.parse(RV.fingerprint(mk('B'), env));
  assert.strictEqual(hidden[hidden.length - 1], 'asked-hidden');
  assert.strictEqual(hidden[0], '');
  const shown = RV.fingerprint(mk('A'), env);
  assert.strictEqual(shown, '["","","B2.1:"]');
  assert.strictEqual(JSON.stringify(hidden.slice(0, -1)), shown);
  assert.notStrictEqual(RV.fingerprint(mk('B'), env), shown);
  // answering changes the fingerprint (marker gone, answer in part 0)
  const done = Object.assign({}, env, { answer: 'Yes' });
  assert.strictEqual(RV.fingerprint(mk('B', { pending: null }), done), '["Yes","","B2.1:"]');
  assert.strictEqual(RV.fingerprintAnswered(RV.fingerprint(mk('B'), env)), false);
  assert.strictEqual(RV.fingerprintAnswered(RV.fingerprint(mk('B', { pending: null }), done)), true);
  // planChat: the answer replaces the message, and its fps equal fingerprint()
  const before = RV.planChat({}, mk('B'));
  assert.strictEqual(before.fps[2], RV.fingerprint(mk('B'), env));
  const afterR = mk('B', { pending: null, envelopes: [done] });
  const after = RV.planChat(before.fps, afterR);
  assert.deepStrictEqual(after.replace, [2]);
  assert.strictEqual(after.fps[2], RV.fingerprint(afterR, done));
  // a message that is not the pending one fingerprints as before
  const other = { seq: 1, from: { seat: 'A' }, status: 'continue' };
  assert.strictEqual(RV.fingerprint(mk('B'), other), '["",""]');
});

test('fingerprintAnswered reads the answer out of a fingerprint (layout pinned: the answer is part 0)', () => {
  const env = (answer) => ({ seq: 1, from: { seat: 'A' }, status: 'continue', answer, claims: [{ id: 'A1.1' }] });
  const R = view({ envelopes: [env('Yes')] });
  // The layout fingerprintAnswered relies on: a JSON array whose first part is the answer.
  assert.strictEqual(JSON.parse(RV.fingerprint(R, env('Yes')))[0], 'Yes');
  assert.strictEqual(JSON.parse(RV.fingerprint(R, env()))[0], '');
  assert.strictEqual(RV.fingerprintAnswered(RV.fingerprint(R, env('Yes'))), true);
  assert.strictEqual(RV.fingerprintAnswered(RV.fingerprint(R, env())), false);
  assert.strictEqual(RV.fingerprintAnswered(RV.fingerprint(R, env(''))), false);
  for (const bad of [undefined, null, '', 'not json', '{}', '[]']) assert.strictEqual(RV.fingerprintAnswered(bad), false, String(bad));
});

test('planChat hands back the fingerprints it was given, and an object when given nothing', () => {
  const R = view({ envelopes: [{ seq: 1, from: { seat: 'A' }, status: 'continue' }] });
  const prev = { 1: 'x' };
  assert.strictEqual(RV.planChat(prev, R).prev, prev);
  assert.deepStrictEqual(RV.planChat(null, R).prev, {});
  assert.deepStrictEqual(RV.planChat('nope', R).prev, {});
});

test('chatAnnouncement: a seq the room does not have says nothing', () => {
  const esc = (seq, answer) => ({ seq, from: { seat: 'B' }, status: 'escalate', escalation: { question: 'q' }, answer });
  const R = view({ seat: 'A', envelopes: [esc(1, 'Yes')] });
  const plan = { add: [], replace: [9], remove: [], fps: {}, prev: {} };
  assert.strictEqual(RV.chatAnnouncement(R, plan, {}), null);
});

test('the census: every machine code the server can send (ApiError third arguments, the quota tuple, errors.js constants and factories) is listed in EXPECTED or as MCP-only', () => {
  assert.deepStrictEqual(unclassifiedCodes(), []);
  const found = codesInServer();
  // the census sees what it must: a census that found nothing would pass everything
  for (const code of ['origin', 'content_type', 'rate_limited', 'saving_unavailable', 'signin_required', 'user_limit', 'ip_limit', 'daily_limit', 'shutting_down']) assert.ok(found.has(code), code);
  const { savingUnavailable, signinRequired } = require('../lib/errors');
  assert.strictEqual(savingUnavailable().apiCode, 'saving_unavailable');
  assert.strictEqual(signinRequired().apiCode, 'signin_required');
});
