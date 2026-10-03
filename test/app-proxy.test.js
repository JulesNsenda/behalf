'use strict';
// createApp wired to the REAL proxy (lib/proxy.js) with a fake fetch: the seam overrides.fetch/clock/timeouts reaches
// createProxy, the key comes from secrets, and a built-in room runs to a terminal state through a retried 503.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { loadConfig, loadSecrets } = require('../lib/config');
const { createLog } = require('../lib/log');
const { mkTmp, rmTmp } = require('../test-support/server');

const T = { timeout: 20000 };
const KEY = 'sk-ant-APPPROXY-77';
const CARD = (name) => ({ principal: { name, role: 'tester' }, goal: 'a goal', must_haves: ['a must-have'] });
const FULL = (name) => Object.assign({ may_agree_to: [], must_never: [], escalate_when: [], known_facts: [] }, CARD(name));
const text = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(o) }] }) });
const authorityRoom = () => ({ id: 'r', seats: { A: { card: FULL('a') }, B: { card: FULL('b') } } });

// Saves and restores the two secrets a default createApp deletes from process.env.
function guardEnv(t) {
  const saved = {};
  for (const k of ['ROOM_PASSCODE', 'ANTHROPIC_API_KEY']) saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
  delete process.env.ROOM_PASSCODE; // a default createApp reads and deletes it, so start without one
  t.after(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
}

function setup(t, extra) {
  const dir = mkTmp('app-proxy-');
  t.after(() => rmTmp(dir));
  const out = [];
  const app = createApp(Object.assign({
    config: loadConfig({ DROP_DATA_DIR: path.join(dir, 'data') }),
    log: createLog({ stream: { write: (s) => out.push(s) } }),
    file: path.join(dir, 'data', 'rooms.json'),
  }, extra));
  t.after(() => app.close());
  return { app, out };
}

async function settle(room) {
  for (let i = 0; i < 400 && room.running; i++) await new Promise((r) => setImmediate(r));
  assert.equal(room.running, false, 'the run settled');
}

test('createApp builds the real proxy from secrets, retries a 503 through the injected fetch and reaches agreement', T, async (t) => {
  guardEnv(t);
  process.env.ANTHROPIC_API_KEY = KEY;
  const turns = [
    { ok: false, status: 503, headers: { get: () => null }, json: async () => ({ error: { type: 'overloaded_error', message: 'Overloaded' } }) },
    text({ message: 'm', status: 'continue', proposal: { terms: ['the term'], depends_on: [] } }),
    text({ message: 'm', status: 'agree' }),
  ];
  const calls = [];
  const sleeps = [];
  const fetch = async (url, init) => {
    calls.push({ url, key: init.headers['x-api-key'] });
    const body = JSON.parse(init.body);
    if (body.system.includes('You audit an agreement')) return text({ terms: [{ A: 'must_haves', B: 'must_haves', note: 'ok' }] });
    return turns.shift();
  };
  const { app, out } = setup(t, { fetch, clock: { sleep: async (ms) => { sleeps.push(ms); } } });
  assert.equal(app.proxy.live(), true);
  assert.equal(app.proxy.MODEL, 'claude-sonnet-5-5');
  assert.equal('ANTHROPIC_API_KEY' in process.env, false, 'removed from the environment once read');

  const room = app.domain.createLiveRoom('1.2.3.4', { topic: 'T', nameA: 'Ann', nameB: 'Ben', modeA: 'builtin', modeB: 'builtin' });
  app.domain.sealCard(room, 'A', CARD('Ann'), 'test');
  app.domain.sealCard(room, 'B', CARD('Ben'), 'test');
  await settle(room);

  assert.equal(room.status, 'agreed');
  assert.equal(sleeps.length, 1, 'one backoff for the one 503');
  assert.ok(calls.length >= 4);
  assert.ok(calls.every((c) => c.url === 'https://api.anthropic.com/v1/messages' && c.key === KEY));
  assert.ok(out.some((l) => l.includes('event="proxy.retry"') && l.includes('httpStatus=503')));
  assert.ok(!out.join('').includes(KEY), 'the key never reaches the log');
});

test('the timeouts override reaches the proxy', T, async (t) => {
  guardEnv(t);
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const { app } = setup(t, { secrets: loadSecrets({ ANTHROPIC_API_KEY: KEY }), fetch: hang, timeouts: { attemptMs: 10 } });
  await assert.rejects(() => app.proxy.mapAuthority(authorityRoom(), ['t']), /timed out/);
});

test('createApp deletes ANTHROPIC_API_KEY only when it loaded the secrets itself', T, async (t) => {
  guardEnv(t);
  process.env.ANTHROPIC_API_KEY = KEY;
  const loaded = setup(t, {});
  assert.equal('ANTHROPIC_API_KEY' in process.env, false, 'removed when createApp read the secrets');
  assert.equal(loaded.app.proxy.live(), true, 'the key was read before it was deleted');

  process.env.ANTHROPIC_API_KEY = 'left-alone';
  const overridden = setup(t, { secrets: loadSecrets({}) });
  assert.equal(process.env.ANTHROPIC_API_KEY, 'left-alone', 'left alone when the caller supplied secrets');
  assert.equal(overridden.app.proxy.live(), false, 'the supplied secrets have no key');
});

test('PXP_MODEL reaches the proxy and the request body through createApp', T, async (t) => {
  guardEnv(t);
  const bodies = [];
  const fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return text({ terms: [] }); };
  const { app } = setup(t, {
    config: loadConfig({ PXP_MODEL: 'model-from-env', DROP_DATA_DIR: path.join(mkTmp('app-proxy-model-'), 'data') }),
    secrets: loadSecrets({ ANTHROPIC_API_KEY: KEY }),
    fetch,
  });
  assert.equal(app.proxy.MODEL, 'model-from-env');
  await app.proxy.mapAuthority(authorityRoom(), ['t']);
  assert.equal(bodies[0].model, 'model-from-env');
});

test('a draft goes through the real proxy with its room, so beforeCall sees (room, "draft")', T, async (t) => {
  const { createProxy } = require('../lib/proxy');
  const seen = [];
  const proxy = createProxy({
    apiKey: KEY, model: 'm',
    fetch: async () => text({ principal: { name: 'x' }, goal: 'g', must_haves: ['m'] }),
    beforeCall: (room, kind) => { seen.push([room, kind]); },
  });
  const { app } = setup(t, { secrets: loadSecrets({}), proxy });
  const room = app.domain.createLiveRoom('1.2.3.4', { topic: 'T', nameA: 'Ann', nameB: 'Ben' });
  const card = await app.domain.draftCard(room, 'A', { text: 'a brief', name: 'Ann' });
  assert.equal(card.principal.name, 'Ann');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], room, 'the room reached beforeCall');
  assert.equal(seen[0][1], 'draft');
});
