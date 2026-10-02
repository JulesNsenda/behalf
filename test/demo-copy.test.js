'use strict';
// The scripted demo is the first thing a visitor reads, so it must stay in plain language,
// and its scripted turns must still pass protocol enforcement.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ROOT, readRepo } = require('../test-support/paths');
const { JARGON } = require('../test-support/copy');
const { PLAIN_WRITING, BANNED_LIST } = require('../lib/writing');
const { INSTRUCTIONS } = require('../lib/mcp');
const { start, mkTmp, rmTmp } = require('../test-support/server');
const demo = require('../lib/demo');

// Every string a person can read. Refs, claim IDs, depends_on and branch keys are protocol and are left out.
function visibleStrings() {
  const out = [{ where: 'topic', text: demo.topic }];
  for (const [seat, card] of Object.entries(demo.cards)) {
    for (const [k, v] of Object.entries(card)) {
      if (typeof v === 'string') out.push({ where: `cards.${seat}.${k}`, text: v });
      else if (Array.isArray(v)) v.forEach((t, i) => out.push({ where: `cards.${seat}.${k}[${i}]`, text: t }));
      else Object.entries(v).forEach(([f, t]) => out.push({ where: `cards.${seat}.${k}.${f}`, text: t }));
    }
  }
  const turn = (where, raw) => {
    out.push({ where: `${where}.message`, text: raw.message });
    (raw.claims || []).forEach((c, i) => out.push({ where: `${where}.claims[${i}]`, text: c.text }));
    (raw.reviews || []).forEach((r, i) => out.push({ where: `${where}.reviews[${i}]`, text: r.reason }));
    ((raw.proposal || {}).terms || []).forEach((t, i) => out.push({ where: `${where}.terms[${i}]`, text: t }));
    if (raw.escalation) {
      out.push({ where: `${where}.question`, text: raw.escalation.question });
      out.push({ where: `${where}.reason`, text: raw.escalation.reason });
    }
  };
  demo.opening.forEach((s, i) => turn(`opening[${i}]`, s.raw));
  for (const [key, steps] of Object.entries(demo.branches)) steps.forEach((s, i) => turn(`branches.${key}[${i}]`, s.raw));
  for (const [key, text] of Object.entries(demo.answers)) out.push({ where: `answers.${key}`, text });
  for (const [key, rows] of Object.entries(demo.authority)) rows.forEach((r, i) => out.push({ where: `authority.${key}[${i}]`, text: r.note }));
  demo.options.forEach((o, i) => out.push({ where: `option label ${i}`, text: o.label }));
  return out;
}

test('the jargon pattern catches what it should', () => {
  for (const bad of ['see B2.2', 'my principal', 'The proxy said', 'dedupe store', 'the webhook', 'Escalating now', 'Your Intent Card', 'raw card data']) {
    assert.ok(JARGON.test(bad), `should match: ${bad}`);
  }
  for (const ok of ['Insist on a duplicate check', "Kwame's AI guessed this"]) {
    assert.ok(!JARGON.test(ok), `should not match: ${ok}`);
  }
});

test('the collector finds the strings, so the check below is not vacuous', () => {
  const all = visibleStrings();
  assert.ok(all.length > 60, 'only ' + all.length + ' strings collected');
  assert.ok(all.every(s => typeof s.text === 'string'), 'a collected value is not a string');
  assert.strictEqual(all.filter(s => s.where.startsWith('option label')).length, 2);
  assert.strictEqual(demo.topic, 'How our shop confirms paid orders');
});

// The two choices the visitor sees are pinned as literals, so the copy can't drift unnoticed.
test('the demo choices, labels and answers are what the visitor reads', () => {
  assert.deepStrictEqual(demo.options, [
    { key: 'dedupe', label: 'Insist on a duplicate check' },
    { key: 'accept', label: 'Accept their plan anyway' },
  ]);
  assert.deepStrictEqual(demo.answers, {
    dedupe: "Insist on a duplicate check. We can't risk shipping an order twice.",
    accept: "Accept their plan anyway. We're short on time.",
  });
});

test('choices, branches and authority are keyed alike, so every option has a script and an audit', () => {
  const keys = o => Object.keys(o).sort();
  assert.deepStrictEqual(keys(demo.choices), ['accept', 'dedupe']);
  assert.deepStrictEqual(keys(demo.branches), keys(demo.choices));
  assert.deepStrictEqual(keys(demo.authority), keys(demo.choices));
  assert.deepStrictEqual(keys(demo.answers), keys(demo.choices));
});

test('no authority note speaks to "you" or "your", since either person reads it', () => {
  const YOU = /\byour?\b/i;
  const bad = visibleStrings().filter(s => s.where.startsWith('authority.') && YOU.test(s.text)).map(s => `${s.where}: ${s.text}`);
  assert.deepStrictEqual(bad, []);
  assert.ok(YOU.test('Allowed by your instructions.') && !YOU.test("Allowed by Lerato's instructions."));
});

test('no demo text a person can read uses jargon', () => {
  const bad = visibleStrings().filter(s => JARGON.test(s.text)).map(s => `${s.where}: ${s.text}`);
  assert.deepStrictEqual(bad, []);
});

// The plain-writing guidance is a presentation guideline: it sits in its own section, and the protocol rules stay as they were.
const GUIDE = /how to write for the people reading/i;

test('the proxy prompt keeps its six protocol rules verbatim and puts plain writing in its own section', () => {
  const src = readRepo('lib/proxy.js');
  const start = src.indexOf('PROTOCOL RULES (Proxy Exchange Protocol v0):');
  const guide = src.search(GUIDE);
  const end = src.indexOf('Return ONLY JSON:', start);
  assert.ok(start > 0 && guide > start && end > guide, 'the section should sit between the rules and the JSON shape');
  const rules = src.slice(start, guide);
  assert.deepStrictEqual(rules.match(/^\d+\. /gm), ['1. ', '2. ', '3. ', '4. ', '5. ', '6. ']);
  for (const line of [
    '1. Every fact you rely on is a claim with an origin:',
    '2. Anything the other proxy claimed is NEVER "stated" for you. Repeating it does not make it true.',
    '3. Review every claim from the other side you have not reviewed yet: accept / challenge (cannot verify) / conflict (contradicts your card).',
    '4. You MUST escalate (status "escalate", one concrete question for your principal) when: agreeing would cross must_never or go beyond may_agree_to; an escalate_when condition matches; a conflict cannot be resolved within your authority; or a proposal relies on an unverified assumption that affects a must_have.',
    `5. To propose, include proposal.terms. To accept the other side's latest proposal exactly, set status "agree" (do not include a proposal). Never agree while raising a conflict.`,
    '6. Be concise and concrete. Converge within a few turns. Do not reveal private limits (like maximum budgets) unless necessary.',
  ]) assert.ok(rules.includes(line), 'rule changed: ' + line);
  assert.ok(src.slice(guide, end).includes('${PLAIN_WRITING}'), 'the section is the shared paragraph');
  assert.ok(/domain vocabulary is fine/.test(PLAIN_WRITING));
  assert.ok(!/\$\{seat\.card\.principal\.name\}/.test(src.slice(guide, end)), 'use a neutral example name');
});

test('the MCP instructions keep their protocol bullets and put plain writing in its own section', () => {
  const src = readRepo('lib/mcp.js');
  const start = src.indexOf('Protocol rules you must follow:');
  const guide = src.search(GUIDE);
  assert.ok(start > 0 && guide > start);
  const rules = src.slice(start, guide);
  assert.strictEqual((rules.match(/^- /gm) || []).length, 5);
  for (const line of [
    '- Tag every claim you rely on: "stated" (your principal said it; ref = card clause like "must_never[0]" or "amendment[0]"), "sourced" (ref = named document/system), or "assumed" (you inferred it). If nobody told you, it is assumed.',
    '- Anything the other proxy claimed is never "stated" for you.',
    '- Review every unreviewed claim from the other side: accept, challenge (cannot verify), or conflict (contradicts your card).',
    '- Escalate (status "escalate" with one concrete question) instead of agreeing to anything outside your card, anything that crosses a must_never, any escalate_when condition, or a proposal resting on an unverified assumption that touches a must_have.',
    `- status "agree" accepts the other side's latest proposal exactly. Never agree while raising a conflict.`,
    'The server enforces these rules and records every turn in a hash-chained ledger.',
  ]) assert.ok(rules.split(/\n/).includes(line), 'rule changed: ' + line);
  assert.ok(src.slice(guide).includes('${PLAIN_WRITING}'), 'the section is the shared paragraph');
  assert.ok(INSTRUCTIONS.endsWith('\n' + PLAIN_WRITING), 'the built instructions end with the shared paragraph');
});

test('the banned-word list is written once and shared by all three prompts', () => {
  assert.strictEqual(BANNED_LIST, '"principal", "proxy", "escalate", "intent card" or "card"');
  assert.ok(PLAIN_WRITING.includes(BANNED_LIST));
  assert.ok(INSTRUCTIONS.includes(BANNED_LIST));
  const src = readRepo('lib/proxy.js');
  const auth = src.slice(src.indexOf('const AUTH_SYSTEM'), src.indexOf('async function mapAuthority'));
  assert.ok(auth.includes('${BANNED_LIST}'), 'the audit prompt interpolates the shared list');
  assert.ok(/third person/.test(auth) && /never "you" or "your"/.test(auth), 'the audit note stays third person');
  assert.ok(src.slice(src.indexOf('HOW TO WRITE FOR THE PEOPLE READING')).includes('${PLAIN_WRITING}'));
});

// The scripted turns run through pxp.buildEnvelope inside the server.
let server = null;
let dir = null;
let base = '';

before(async () => {
  dir = mkTmp('demo-copy-');
  server = await start(path.join(ROOT, 'index.js'), { PORT: '0', BIND_HOST: '127.0.0.1', DEMO_DELAY_MS: '20', DROP_DATA_DIR: dir });
  assert.strictEqual(server.exited, undefined, 'server exited early with code ' + server.exited + '. Output:\n' + server.out);
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  if (server) await server.stop();
  if (dir) rmTmp(dir);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(p, body) {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, json: await res.json() };
}

async function until(get, ok) {
  let v;
  for (let i = 0; i < 150; i++) { v = await get(); if (ok(v)) return v; await sleep(40); }
  assert.fail('timed out; last status ' + (v && v.status));
}

async function runBranch(option) {
  const { json: d } = await post('/api/demo');
  for (const seat of ['A', 'B']) assert.strictEqual((await post(`/api/rooms/${d.id}/seats/${seat}/seal`, { token: d.token })).status, 200);
  const get = () => fetch(`${base}/api/rooms/${d.id}?seat=A&t=${d.token}`).then(r => r.json());
  const asked = await until(get, v => v.status === 'paused' && v.pending);
  assert.strictEqual((await post(`/api/rooms/${d.id}/seats/A/answer`, { token: d.token, option: option })).status, 200);
  const done = await until(get, v => v.status !== 'negotiating' && v.status !== 'paused');
  return { asked, done };
}

test('the dedupe branch is agreed with nothing unverified, and no turn is flagged', async () => {
  const { asked, done } = await runBranch('dedupe');
  assert.deepStrictEqual(asked.pending.options.map(o => o.key), ['dedupe', 'accept']);
  assert.strictEqual(asked.pending.question, demo.opening[2].raw.escalation.question);
  assert.strictEqual(done.status, 'agreed');
  assert.strictEqual(done.brief.unverified_dependencies.length, 0);
  assert.strictEqual(done.brief.ledger_ok, true);
  assert.strictEqual(done.envelopes.length, 5);
  assert.deepStrictEqual(done.envelopes.map(e => e.protocol_flags || []), [[], [], [], [], []]);
  assert.deepStrictEqual(done.brief.authority.map(a => [a.A, a.B]), demo.authority.dedupe.map(a => [a.A, a.B]));
  assert.deepStrictEqual(done.brief.agreement.terms, demo.branches.dedupe[0].raw.proposal.terms);
});

test('the accept branch is agreed with the unconfirmed guess recorded, and no turn is flagged', async () => {
  const { done } = await runBranch('accept');
  assert.strictEqual(done.status, 'agreed');
  assert.ok(done.brief.unverified_dependencies.length >= 1);
  assert.strictEqual(done.brief.ledger_ok, true);
  assert.strictEqual(done.envelopes.length, 4);
  assert.deepStrictEqual(done.envelopes.map(e => e.protocol_flags || []), [[], [], [], []]);
  assert.deepStrictEqual(done.brief.authority.map(a => [a.A, a.B]), demo.authority.accept.map(a => [a.A, a.B]));
});
