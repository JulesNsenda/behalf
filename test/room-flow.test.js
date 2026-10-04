'use strict';
// Drives the real server's scripted demo over HTTP through both branches and checks what the
// room and agreement pages' pure logic (RoomView, AgreementView) decide on the REAL snapshots.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ROOT } = require('../test-support/paths');
const { start, mkTmp, rmTmp, postJson, getView: fetchView } = require('../test-support/server');
const { loadPure } = require('../test-support/source');

const { mod: RoomView } = loadPure('room-view');
const { mod: AgreementView } = loadPure('agreement-view', { allowRequire: true });

let server = null;
let dir = null;
let base = '';

before(async () => {
  dir = mkTmp('room-flow-');
  server = await start(path.join(ROOT, 'index.js'), {
    PORT: '0', BIND_HOST: '127.0.0.1', SIGNIN: 'off', DROP_DATA_DIR: dir, DEMO_DELAY_MS: '60',
  });
  assert.strictEqual(server.exited, undefined, 'server exited early with code ' + server.exited + '. Output:\n' + server.out);
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  if (server) await server.stop();
  if (dir) rmTmp(dir);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (p, body) => postJson(base, p, body);
const getView = (id, seat, token) => fetchView(base, id, seat, token);

// Poll until pred(R) holds; fail with the last status if it doesn't within the deadline.
async function until(id, token, pred, what) {
  const end = Date.now() + 5000;
  let R = null;
  while (Date.now() < end) {
    R = (await getView(id, 'A', token)).R;
    if (pred(R)) return R;
    await sleep(10);
  }
  assert.fail('timed out waiting for ' + what + '; last status ' + (R && R.status));
}

// Poll until pred(seatView, spectatorView) holds. Both are fetched together on every poll, so the pair
// can't straddle a transition (a seat view from before it and a spectator view from after).
async function untilBoth(id, token, pred, what) {
  const end = Date.now() + 5000;
  let pair = null;
  while (Date.now() < end) {
    pair = await Promise.all([getView(id, 'A', token), getView(id)]).then(([a, b]) => [a.R, b.R]);
    if (pred(pair[0], pair[1])) return pair;
    await sleep(10);
  }
  assert.fail('timed out waiting for ' + what + '; last status ' + (pair && pair[0] && pair[0].status));
}

// Drive one demo room through a branch, returning the snapshots taken at each transition.
async function drive(branch) {
  const created = await post('/api/demo');
  assert.strictEqual(created.status, 201);
  const { id, token } = created.json;
  const snap = { id, token };
  const as = async (seat) => (await getView(id, seat, token)).R;
  const spectator = async () => (await getView(id)).R;

  snap.draftingA = await as('A');
  snap.draftingSpectator = await spectator();
  snap.badToken = (await getView(id, 'B', 'wrong')).R;
  snap.draftingAgain = await as('A');

  assert.strictEqual((await post(`/api/rooms/${id}/seats/A/seal`, { token })).status, 200);
  snap.sealedA = await as('A');
  snap.sealedASpectator = await spectator();
  assert.strictEqual((await post(`/api/rooms/${id}/seats/B/seal`, { token })).status, 200);

  [snap.negotiating, snap.negotiatingSpectator] = await untilBoth(id, token, (R, S) => R.status === 'negotiating' && S.status === 'negotiating', 'negotiating');

  [snap.paused, snap.pausedSpectator] = await untilBoth(id, token, (R, S) => R.status === 'paused' && R.pending && S.status === 'paused', 'a pending question');
  snap.pausedAgain = await as('A');

  const seat = snap.paused.pending.seat;
  assert.strictEqual((await post(`/api/rooms/${id}/seats/${seat}/answer`, { token, option: branch })).status, 200);

  [snap.agreed, snap.agreedSpectator] = await untilBoth(id, token, (R, S) => R.status === 'agreed' && S.status === 'agreed', 'agreement');
  snap.agreedAgain = await as('A');
  return snap;
}

function assertMessages(R, min) {
  assert.ok(R.envelopes.length >= min, 'expected at least ' + min + ' messages');
  for (const env of R.envelopes) {
    const m = RoomView.messageView(R, env);
    assert.ok(m.speaker && typeof m.speaker === 'string', 'speaker label for message ' + env.seq);
    assert.ok(m.ariaLabel.includes(m.speaker));
    assert.strictEqual(m.seq, env.seq);
    assert.ok(typeof m.announce === 'string' && m.announce);
  }
}

// The authority kinds a covered term can show (see AgreementView).
const KNOWN_KINDS = ['must_haves', 'may_agree_to', 'must_never', 'known_facts', 'amendment', 'none'];

// The checks that don't depend on the branch.
// uncovered is how many terms the branch's script leaves outside anyone's instructions (the accept branch has one on purpose).
function checkSnapshots(s, uncovered) {
  const conv = { hadCredentials: true };

  // Drafting, nothing sealed.
  assert.strictEqual(s.draftingA.status, 'drafting');
  assert.strictEqual(s.draftingA.seat, 'A');
  assert.strictEqual(s.draftingA.demo, true);
  assert.strictEqual(RoomView.step(s.draftingA, conv).key, 'demo-intro');
  assert.strictEqual(RoomView.step(s.draftingA, { hadCredentials: true, demoStarted: true }).key, 'conversation');
  assert.deepStrictEqual(RoomView.status(s.draftingA), { label: 'Getting ready', tone: 'info' });
  assert.strictEqual(RoomView.guessCount(s.draftingA), 0);
  assert.strictEqual(RoomView.guessPill(s.draftingA), null);
  assert.strictEqual(RoomView.outcome(s.draftingA), null);
  assert.strictEqual(RoomView.decisionView(s.draftingA), null);
  assert.strictEqual(RoomView.canAnswer(s.draftingA), false);
  for (const R of [s.draftingA, s.draftingSpectator, s.sealedA, s.paused, s.pausedSpectator]) {
    assert.strictEqual(AgreementView.state(R), 'not-yet', 'no brief before the end: ' + R.status);
  }

  // Spectator while drafting.
  assert.strictEqual(s.draftingSpectator.seat, null);
  const spec = RoomView.step(s.draftingSpectator, {});
  assert.strictEqual(spec.key, 'spectator-drafting');
  assert.strictEqual(spec.readOnly, true);
  assert.strictEqual(s.draftingSpectator.seats.A.card, undefined, 'a spectator never gets a card');

  // A bad token on a demo room is just a spectator: demo rooms never take the invalid-link step.
  assert.strictEqual(s.badToken.seat, null);
  const bad = RoomView.step(s.badToken, conv);
  assert.strictEqual(bad.banner, null);
  assert.strictEqual(bad.key, 'spectator-drafting');
  assert.strictEqual(bad.readOnly, true);
  assert.strictEqual(RoomView.canAnswer(s.badToken), false);

  // A sealed (the demo shares one token, so viewer A is also in the conversation).
  assert.strictEqual(s.sealedA.status, 'drafting');
  assert.strictEqual(s.sealedA.seats.A.sealed, true);
  assert.strictEqual(RoomView.step(s.sealedA, conv).key, 'conversation');
  assert.strictEqual(RoomView.status(s.sealedA).label, 'Getting ready');
  assert.strictEqual(RoomView.step(s.sealedASpectator, {}).key, 'spectator-drafting');

  // Negotiating.
  for (const R of [s.negotiating, s.negotiatingSpectator]) {
    assert.strictEqual(R.status, 'negotiating');
    const st = RoomView.step(R, R.seat ? conv : {});
    assert.strictEqual(st.key, 'conversation');
    assert.strictEqual(st.readOnly, !R.seat);
    assert.strictEqual(st.connectCallout, false);
    assert.strictEqual(RoomView.status(R).tone, 'info');
    assert.strictEqual(RoomView.canAnswer(R), false);
    assert.strictEqual(RoomView.decisionView(R), null);
    assert.strictEqual(RoomView.outcome(R), null);
  }
  assert.deepStrictEqual(RoomView.status(s.negotiating), { label: 'Talking', tone: 'info' });

  // Paused with a pending question.
  const P = s.paused;
  assert.strictEqual(P.status, 'paused');
  assert.ok(P.pending && P.pending.question);
  assert.strictEqual(RoomView.step(P, conv).key, 'conversation');
  assert.deepStrictEqual(RoomView.status(P), { label: 'Waiting for you', tone: 'warn' });
  assert.strictEqual(RoomView.canAnswer(P), true);
  assert.ok(RoomView.guessCount(P) >= 1, 'the unconfirmed claim counts before the deal');
  assert.match(RoomView.guessPill(P), /^\d+ guess(es)? not confirmed$/);
  assert.strictEqual(RoomView.outcome(P), null);
  assert.strictEqual(RoomView.problem(P), null);
  const dv = RoomView.decisionView(P);
  assert.ok(dv, 'the demo viewer gets a decision');
  assert.strictEqual(dv.key, P.pending.seq);
  // The question is the AI's text, so it is shown quoted under a fixed, attributed heading.
  assert.strictEqual(dv.question, P.pending.question.trim());
  assert.match(dv.heading, /asks you:$/);
  assert.ok(!dv.heading.includes(dv.question), 'the heading never carries the AI-written question');
  assert.ok(dv.quote.includes(dv.question));
  assert.deepStrictEqual(dv.options.map((o) => o.key).sort(), ['accept', 'dedupe']);
  assert.ok(dv.options.every((o) => o.label));
  assert.ok(dv.visibilityNote && dv.dock.text && dv.dock.action);
  // The spectator sees the waiting line and no decision.
  const PS = s.pausedSpectator;
  assert.strictEqual(RoomView.canAnswer(PS), false);
  assert.strictEqual(RoomView.decisionView(PS), null);
  assert.strictEqual(RoomView.status(PS).tone, 'warn');
  assert.match(RoomView.status(PS).label, /^Waiting for .+ to answer their AI$/);
  assert.strictEqual(RoomView.waitingEvent(PS), RoomView.status(PS).label);
  assert.strictEqual(RoomView.step(PS, {}).readOnly, true);

  // Agreed.
  for (const R of [s.agreed, s.agreedSpectator]) {
    assert.strictEqual(R.status, 'agreed');
    assert.deepStrictEqual(RoomView.status(R), { label: 'Deal reached', tone: 'ok' });
    assert.strictEqual(RoomView.step(R, R.seat ? conv : {}).key, 'conversation');
    assert.strictEqual(RoomView.canAnswer(R), false);
    assert.strictEqual(RoomView.decisionView(R), null);
    assert.strictEqual(RoomView.problem(R), null);
    assert.ok(R.brief && R.brief.agreement && R.brief.agreement.terms.length > 0);
  }

  // Messages never throw and always name a speaker, on every snapshot that has any.
  // The negotiating snapshot may be taken before the first turn lands.
  for (const R of [s.negotiating, s.negotiatingSpectator]) assertMessages(R, 0);
  for (const R of [s.paused, s.pausedSpectator, s.agreed, s.agreedSpectator]) assertMessages(R, 1);

  // The viewer is "Your AI" on the end side; a spectator never is, and sees A on the end.
  const first = s.agreed.envelopes[0];
  const mine = RoomView.messageView(s.agreed, first);
  const theirs = RoomView.messageView(s.agreedSpectator, first);
  assert.strictEqual(mine.seat, 'A');
  assert.strictEqual(theirs.seat, 'A');
  assert.strictEqual(mine.end, true);
  assert.strictEqual(theirs.end, true);
  assert.strictEqual(mine.speaker, 'Your AI');
  assert.notStrictEqual(theirs.speaker, 'Your AI');
  assert.ok(theirs.speaker.endsWith("'s AI"));

  // Fingerprints are stable between identical fetches, and differ once an answer lands.
  for (const [a, b] of [[s.draftingA, s.draftingAgain], [s.paused, s.pausedAgain], [s.agreed, s.agreedAgain]]) {
    assert.strictEqual(a.envelopes.length, b.envelopes.length);
    a.envelopes.forEach((env, i) => assert.strictEqual(RoomView.fingerprint(a, env), RoomView.fingerprint(b, b.envelopes[i])));
  }
  const escalated = s.paused.envelopes.find((e) => e.status === 'escalate');
  assert.ok(escalated, 'the paused room has an escalation message');
  const escalatedAfter = s.agreed.envelopes.find((e) => e.seq === escalated.seq);
  assert.notStrictEqual(RoomView.fingerprint(s.paused, escalated), RoomView.fingerprint(s.agreed, escalatedAfter), 'the answer changes the fingerprint');
  const events = RoomView.escalationEvents(s.agreed, escalatedAfter).map((e) => e.kind);
  assert.deepStrictEqual(events, ['asked', 'answered']);

  // Record entries have wording for every ledger entry.
  for (const e of s.agreed.ledger) assert.ok(RoomView.recordEntry(s.agreed, e));
  assert.strictEqual(RoomView.recordStatus(s.agreed.ledgerCheck.ok), 'Record checks out');

  // Agreement page: state, one point per agreed term, summary free of URLs and tokens.
  for (const [R, seat] of [[s.agreed, 'A'], [s.agreedSpectator, null]]) {
    assert.strictEqual(AgreementView.state(R), 'agreed');
    const pts = AgreementView.points(R, seat);
    assert.strictEqual(pts.terms.length, R.brief.agreement.terms.length);
    pts.terms.forEach((t, i) => {
      assert.strictEqual(t.number, i + 1);
      assert.strictEqual(t.term, R.brief.agreement.terms[i]);
      assert.ok(t.lines.length > 0, 'every demo term has why-lines');
      for (const l of t.lines) assert.ok(KNOWN_KINDS.includes(l.kind), 'known kind: ' + l.kind);
    });
    assert.strictEqual(pts.uncovered, uncovered, 'uncovered terms in this branch');
    assert.strictEqual(pts.note, null);
    assert.match(AgreementView.heading(R, seat), seat ? /^What you and \w+ agreed$/ : /^What \w+ and \w+ agreed$/);
    assert.match(AgreementView.heading(R, seat, true), /^What \w+ and \w+ agreed$/);
    const text = AgreementView.summaryText(R, seat);
    assert.ok(text.includes(R.topic), 'the summary names the topic');
    assert.doesNotMatch(text, /https?:|\/room\/|\/brief\/|[?&]t=|token/i);
    assert.ok(AgreementView.heading(R, seat));
  }
}

test('demo flow, dedupe branch: nothing unconfirmed', async () => {
  const s = await drive('dedupe');
  checkSnapshots(s, 0);

  assert.strictEqual(RoomView.guessCount(s.agreed), 0);
  assert.strictEqual(RoomView.guessPill(s.agreed), null);
  assert.deepStrictEqual(RoomView.outcome(s.agreed), { tone: 'ok', text: 'Deal reached. Nothing unconfirmed.', linkLabel: 'See the agreement', replayable: true });
  assert.strictEqual(RoomView.outcome(s.agreedSpectator).tone, 'ok');
  assert.strictEqual(RoomView.outcome(s.agreedSpectator).replayable, false, 'a spectator can not replay the demo');
  assert.strictEqual(s.agreed.brief.unverified_dependencies.length, 0);
  assert.strictEqual(RoomView.outcome(s.agreed).text, RoomView.outcome({ status: 'agreed', brief: s.agreed.brief }).text);
  assert.match(AgreementView.summaryText(s.agreed, 'A'), /Nothing unconfirmed/);
});

test('demo flow, accept branch: one unconfirmed point', async () => {
  const s = await drive('accept');
  checkSnapshots(s, 1);
  assert.deepStrictEqual(AgreementView.points(s.agreed, 'A').terms.filter((t) => t.flagged).map((t) => t.flagLabel), ["Not covered by one person's instructions"]);
  const relied = AgreementView.reliedGuesses(s.agreed, 'A');
  assert.strictEqual(relied.length, 1);
  assert.ok(relied[0].text && relied[0].note);

  assert.strictEqual(s.agreed.brief.unverified_dependencies.length, 1);
  assert.strictEqual(RoomView.guessCount(s.agreed), 1);
  assert.strictEqual(RoomView.guessPill(s.agreed), '1 guess not confirmed');
  assert.deepStrictEqual(RoomView.outcome(s.agreed), { tone: 'warn', text: 'Deal reached, with 1 unconfirmed point', linkLabel: 'See the agreement', replayable: true });
  assert.strictEqual(RoomView.outcome(s.agreedSpectator).tone, 'warn');
  assert.match(AgreementView.summaryText(s.agreed, 'A'), /Relies on points nobody confirmed/);
  assert.doesNotMatch(AgreementView.summaryText(s.agreed, 'A'), /Nothing unconfirmed/);
});

test('an unknown room is a 404 and the not-found step', async () => {
  const { status, R } = await getView('nosuchroom');
  assert.strictEqual(status, 404);
  assert.strictEqual(R, null);
  assert.deepStrictEqual(RoomView.step(null, {}), { key: 'not-found', banner: null, readOnly: true, connectCallout: false });
  assert.strictEqual(AgreementView.state(null), 'not-found');
});

test('a live room with two external seats (no AI key): join, ready, preview and invalid-link steps', async () => {
  const created = await post('/api/rooms', { topic: 'Shared roof', nameA: 'Lerato Mokoena', nameB: 'Kwame Asante', modeA: 'external', modeB: 'external' });
  assert.strictEqual(created.status, 201);
  const { id, links, modes } = created.json;
  assert.deepStrictEqual(modes, { A: 'external', B: 'external' });
  const tok = (seat) => new URL(links[seat], 'http://x').searchParams.get('t');
  const tA = tok('A');
  const tB = tok('B');
  const view = async (seat, t) => (await getView(id, seat, t)).R;
  const creds = { hadCredentials: true };

  // Seat A skips the welcome and goes straight to instructions.
  const A0 = await view('A', tA);
  assert.strictEqual(A0.demo, false);
  assert.strictEqual(A0.seat, 'A');
  const stA = RoomView.step(A0, creds);
  assert.strictEqual(stA.key, 'instructions');
  assert.strictEqual(stA.connectCallout, false);
  assert.strictEqual(stA.readOnly, false);
  assert.deepStrictEqual(RoomView.status(A0), { label: 'Getting ready', tone: 'info' });

  // Seat B welcome, then instructions once the welcome has been seen.
  const B0 = await view('B', tB);
  assert.strictEqual(B0.seat, 'B');
  assert.strictEqual(RoomView.step(B0, { hadCredentials: true, welcomeSeen: false }).key, 'welcome');
  assert.strictEqual(RoomView.step(B0, { hadCredentials: true, welcomeSeen: true }).key, 'instructions');

  // A wrong token on a real room is an invalid link, read-only, falling back to the drafting spectator view.
  const bad = await view('B', 'wrong');
  assert.strictEqual(bad.seat, null);
  const stBad = RoomView.step(bad, creds);
  assert.strictEqual(stBad.key, 'spectator-drafting');
  assert.strictEqual(stBad.banner, 'invalid-link');
  assert.strictEqual(stBad.readOnly, true);

  // Spectator and token-free preview.
  const spec = await view();
  assert.strictEqual(RoomView.step(spec, {}).key, 'spectator-drafting');
  assert.strictEqual(RoomView.step(spec, {}).readOnly, true);
  const pv = RoomView.step(spec, { previewSeat: 'B' });
  assert.strictEqual(pv.key, 'welcome');
  assert.strictEqual(pv.banner, 'preview');
  assert.strictEqual(pv.readOnly, true);
  assert.strictEqual(RoomView.step(spec, { previewSeat: 'A' }).key, 'spectator-drafting');
  assert.strictEqual(spec.seats.B.card, undefined);

  // Lock A's instructions: A is ready, B still sees the welcome, and the preview ends once B has locked.
  const card = RoomView.cardFromFields({ goal: 'Agree who pays for the roof', must_haves: 'Work starts in May\nA written quote' }, { name: 'Lerato Mokoena', role: 'Owner' });
  const sealed = await post(`/api/rooms/${id}/seats/A/seal`, { token: tA, card });
  assert.strictEqual(sealed.status, 200);
  const A1 = await view('A', tA);
  assert.strictEqual(A1.status, 'drafting');
  assert.strictEqual(A1.seats.A.sealed, true);
  const stReady = RoomView.step(A1, creds);
  assert.strictEqual(stReady.key, 'ready');
  assert.strictEqual(stReady.connectCallout, false);
  assert.strictEqual(RoomView.status(A1).label, 'Getting ready');
  assert.strictEqual(RoomView.step(await view('B', tB), { hadCredentials: true }).key, 'welcome');
  assert.strictEqual(RoomView.step(await view(), { previewSeat: 'B' }).banner, 'preview');
});
