'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const { createProxy, parseJson, ProxyError } = require('../lib/proxy');
const { createLog } = require('../lib/log');

const KEY = 'sk-ant-SECRETMARKER-9f3a1c';

const okBody = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (headers[k.toLowerCase()] === undefined ? null : headers[k.toLowerCase()]) },
  json: async () => body,
});
const good = () => reply(200, okBody({ message: 'hi' }));
// `type` is Claude's error.type; `message` is free text that the proxy must never copy.
const fail = (status, type, headers, message = 'free text') => reply(status, { error: { type, message } }, headers);

// A fake fetch that plays the queue in order; a function entry is called with (url, init) and may return or throw.
function fakeFetch(queue) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const next = queue[Math.min(calls.length - 1, queue.length - 1)];
    return typeof next === 'function' ? next(url, init) : next;
  };
  f.calls = calls;
  return f;
}

// sleep records the delay and advances now, so the deadline can be tested without waiting.
function fakeClock() {
  const c = { t: 1000, sleeps: [], now: () => c.t, sleep: async (ms) => { c.sleeps.push(ms); c.t += ms; } };
  return c;
}

function logCapture() {
  const lines = [];
  return { lines, log: createLog({ stream: { write: (l) => lines.push(l) } }) };
}

function make(queue, extra = {}) {
  const fetch = fakeFetch(queue);
  const clock = fakeClock();
  const cap = logCapture();
  const proxy = createProxy(Object.assign({ apiKey: KEY, model: 'm-test', fetch, clock, log: cap.log }, extra));
  return { proxy, fetch, clock, cap };
}

// What undici throws: a TypeError whose cause carries the system error code.
const connError = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });

const card = (name) => ({ principal: { name, role: '' }, goal: 'g', must_haves: [], may_agree_to: [], must_never: [], escalate_when: [], known_facts: [] });
const room = () => ({
  id: 'room1', topic: 't', turnCount: 0, maxTurns: 10, claims: {}, envelopes: [],
  seats: { A: { card: card('Ann') }, B: { card: card('Bob') } },
});

// --- retries (takeTurn only) ---

for (const status of [429, 529, 503]) {
  test(`takeTurn retries a ${status} and then succeeds`, async () => {
    const { proxy, fetch, clock, cap } = make([fail(status, 'overloaded_error'), good()]);
    assert.deepEqual(await proxy.takeTurn(room(), 'A'), { message: 'hi' });
    assert.equal(fetch.calls.length, 2);
    assert.equal(clock.sleeps.length, 1);
    assert.ok(clock.sleeps[0] >= 0 && clock.sleeps[0] <= 1000, 'full jitter within the base backoff');
    assert.equal(cap.lines.length, 1);
    assert.match(cap.lines[0], /^level=warn event="proxy\.retry" room="room1" httpStatus=\d+ errorClass="ProxyError" durationMs=\d+ stack=/);
  });
}

test('takeTurn retries every 500, 502, 503 and 504', async () => {
  for (const status of [500, 502, 503, 504]) {
    const { proxy, fetch } = make([fail(status, 'api_error'), good()]);
    await proxy.takeTurn(room(), 'A');
    assert.equal(fetch.calls.length, 2, String(status));
  }
});

test('takeTurn retries a connection error with a pre-send code', async () => {
  const { proxy, fetch, cap } = make([() => { throw connError('ECONNREFUSED'); }, good()]);
  assert.deepEqual(await proxy.takeTurn(room(), 'A'), { message: 'hi' });
  assert.equal(fetch.calls.length, 2);
  assert.match(cap.lines[0], /^level=warn event="proxy\.retry" .* errorClass="ProxyError" code="ECONNREFUSED"/);
});

test('retry-after is honoured in seconds', async () => {
  const { proxy, clock } = make([fail(429, 'rate_limit_error', { 'retry-after': '2' }), good()]);
  await proxy.takeTurn(room(), 'A');
  assert.deepEqual(clock.sleeps, [2000]);
});

test('a retry-after above the cap gives up at once without sleeping', async () => {
  const { proxy, fetch, clock, cap } = make([fail(429, 'rate_limit_error', { 'retry-after': '30' }), good()]);
  await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e instanceof ProxyError && e.httpStatus === 429);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(clock.sleeps, []);
  assert.match(cap.lines[0], /^level=error event="proxy\.gave_up" room="room1" httpStatus=429 /);
});

test('the overall deadline holds: it never sleeps past it', async () => {
  const { proxy, fetch, clock } = make([fail(503, 'overloaded_error', { 'retry-after': '1' })], { timeouts: { deadlineMs: 1500, minAttemptMs: 0 } });
  await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e.httpStatus === 503);
  assert.deepEqual(clock.sleeps, [1000]);
  assert.equal(fetch.calls.length, 2);
  assert.ok(clock.t < 1000 + 1500, 'the clock never crossed the deadline');
});

test('at most 3 attempts, and the final error keeps the last status', async () => {
  const { proxy, fetch, clock, cap } = make([fail(503, 'api_error'), fail(529, 'overloaded_error'), fail(503, 'overloaded_error'), good()]);
  await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e instanceof ProxyError && e.httpStatus === 503 && e.message === 'Claude API 503: overloaded_error');
  assert.equal(fetch.calls.length, 3);
  assert.equal(clock.sleeps.length, 2);
  assert.equal(cap.lines.filter((l) => /event="proxy\.retry"/.test(l)).length, 2);
  assert.equal(cap.lines.filter((l) => /event="proxy\.gave_up"/.test(l)).length, 1);
});

// --- no retry ---

for (const status of [400, 401, 403, 404, 422, 501]) {
  test(`takeTurn does not retry a ${status}`, async () => {
    const { proxy, fetch, clock } = make([fail(status, 'invalid_request_error'), good()]);
    await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e.httpStatus === status && e.message === `Claude API ${status}: invalid_request_error`);
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(clock.sleeps, []);
  });
}

test('a local abort is never retried', async () => {
  const waitForAbort = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const { proxy, fetch, clock } = make([waitForAbort, good()], { timeouts: { attemptMs: 20 } });
  await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e instanceof ProxyError && /timed out/.test(e.message));
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test('a parseJson failure is not retried', async () => {
  const { proxy, fetch } = make([reply(200, { content: [{ type: 'text', text: 'no json here' }] }), good()]);
  await assert.rejects(() => proxy.takeTurn(room(), 'A'), /did not return JSON/);
  assert.equal(fetch.calls.length, 1);
});

test('draftCard and mapAuthority make one attempt, even on a 503', async () => {
  const a = make([fail(503, 'overloaded_error'), good()]);
  await assert.rejects(() => a.proxy.draftCard({ room: room(), name: 'Ann', role: '', topic: 't', text: 'x' }), (e) => e.httpStatus === 503);
  assert.equal(a.fetch.calls.length, 1);
  assert.deepEqual(a.clock.sleeps, []);
  const b = make([fail(503, 'overloaded_error'), good()]);
  await assert.rejects(() => b.proxy.mapAuthority(room(), ['t1']), (e) => e.httpStatus === 503);
  assert.equal(b.fetch.calls.length, 1);
  assert.deepEqual(b.clock.sleeps, []);
});

test('draftCard without a room fails closed, before beforeCall and fetch', async () => {
  let before = 0;
  const { proxy, fetch } = make([good()], { beforeCall: () => { before++; } });
  await assert.rejects(() => proxy.draftCard({ name: 'Ann', role: 'r', topic: 't', text: 'x' }), (e) => e instanceof ProxyError);
  assert.equal(before, 0);
  assert.equal(fetch.calls.length, 0);
});

test('mapAuthority normalises the answer', async () => {
  const m = make([reply(200, okBody({ terms: [{ A: 'must_haves', B: 'bogus', note: 'ok' }] }))]);
  assert.deepEqual(await m.proxy.mapAuthority(room(), ['t1', 't2']), [
    { term: 't1', A: 'must_haves', B: 'none', note: 'ok' },
    { term: 't2', A: 'none', B: 'none', note: '' },
  ]);
});

// --- beforeCall ---

test('beforeCall runs once per attempt, retries included, and receives the room', async () => {
  const seen = [];
  const r = room();
  const { proxy, fetch } = make([fail(503, 'api_error'), fail(503, 'api_error'), good()], { beforeCall: (rm) => { seen.push(rm); } });
  await proxy.takeTurn(r, 'A');
  assert.equal(fetch.calls.length, 3);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((x) => x === r));
});

test('beforeCall is also called by draftCard and mapAuthority with their room', async () => {
  const seen = [];
  const kinds = [];
  const r = room();
  const { proxy } = make([good()], { beforeCall: (rm, kind) => { seen.push(rm); kinds.push(kind); } });
  await proxy.draftCard({ room: r, name: 'Ann', role: '', topic: 't', text: 'x' });
  await proxy.mapAuthority(r, ['t']);
  assert.deepEqual(seen, [r, r]);
  assert.deepEqual(kinds, ['draft', 'authority']);
});

test('a beforeCall that throws propagates, with no fetch and no retry', async () => {
  const boom = new Error('cap reached');
  const { proxy, fetch, clock } = make([good()], { beforeCall: () => { throw boom; } });
  await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e === boom);
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(clock.sleeps, []);
});

test('a beforeCall that throws on a retry stops the loop', async () => {
  let n = 0;
  const boom = new Error('cap reached');
  const { proxy, fetch } = make([fail(503, 'api_error'), good()], { beforeCall: () => { if (++n === 2) throw boom; } });
  await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e === boom);
  assert.equal(fetch.calls.length, 1);
});

// --- secrecy and the key ---

test('the key never reaches an error or a log line, even when Claude echoes it back', async () => {
  const cases = [
    [401, 'authentication_error', undefined],
    [503, 'overloaded_error', undefined],
    [429, 'rate_limit_error', { 'retry-after': '30' }],
    [400, `bogus ${KEY}`, undefined],
  ];
  for (const [status, type, headers] of cases) {
    // the free-text message echoes the key; the type is the only part that may be used
    const { proxy, cap } = make([fail(status, type, headers, `invalid x-api-key: ${KEY} ${KEY}`)]);
    let caught = null;
    try { await proxy.takeTurn(room(), 'A'); } catch (e) { caught = e; }
    assert.ok(caught, String(status));
    assert.match(caught.message, /^Claude API [0-9]{3}: [a-z_ ]+$/);
    assert.ok(!caught.message.includes(KEY), 'message');
    assert.ok(!String(caught.stack).includes(KEY), 'stack');
    assert.ok(!cap.lines.join('\n').includes(KEY), 'log');
    assert.equal(caught.httpStatus, status);
  }
});

test('a connection error carries neither the key nor the underlying message', async () => {
  const { proxy, cap } = make([() => { throw Object.assign(new TypeError(`connect failed for ${KEY}`), { cause: { code: 'ECONNRESET', message: KEY } }); }, () => { throw new TypeError(`connect failed for ${KEY}`); }]);
  let caught = null;
  try { await proxy.takeTurn(room(), 'A'); } catch (e) { caught = e; }
  assert.ok(caught && !caught.message.includes(KEY) && !String(caught.stack).includes(KEY));
  assert.ok(!cap.lines.join('\n').includes(KEY));
  assert.equal(caught.httpStatus, undefined);
  assert.equal(caught.cause && caught.cause.message, undefined, 'only the vetted code is carried');
});

test('with no key, live() is false and a call throws before beforeCall and fetch', async () => {
  let before = 0;
  const { proxy, fetch } = make([good()], { apiKey: '', beforeCall: () => { before++; } });
  assert.equal(proxy.live(), false);
  await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e instanceof ProxyError && e.message === 'ANTHROPIC_API_KEY is not set');
  assert.equal(fetch.calls.length, 0);
  assert.equal(before, 0);
});

test('live() is true with a key, and MODEL is the injected model', () => {
  const { proxy } = make([good()]);
  assert.equal(proxy.live(), true);
  assert.equal(proxy.MODEL, 'm-test');
});

test('the request carries the key only in the x-api-key header', async () => {
  const { proxy, fetch } = make([good()]);
  await proxy.takeTurn(room(), 'A');
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], KEY);
  assert.ok(!init.body.includes(KEY));
  assert.ok(!url.includes(KEY));
  assert.equal(JSON.parse(init.body).model, 'm-test');
  assert.equal(Object.entries(init.headers).filter(([k, v]) => String(v).includes(KEY)).length, 1);
});

test('parseJson tolerates fences and surrounding prose', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure: {"a":1} done'), { a: 1 });
  assert.throws(() => parseJson('nothing'), /did not return JSON/);
});

// --- pass 2 ---

// A response whose body never arrives until the attempt is aborted.
const hangingBody = (status) => (url, init) => ({
  ok: status < 300,
  status,
  headers: { get: () => null },
  json: () => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); }),
});

for (const status of [503, 200]) {
  test(`an abort while reading a ${status} body is a non-retryable timeout`, async () => {
    const { proxy, fetch, clock } = make([hangingBody(status), good()], { timeouts: { attemptMs: 20 } });
    await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e instanceof ProxyError && /timed out/.test(e.message));
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(clock.sleeps, []);
  });
}

test('it gives up rather than start a retry with less than minAttemptMs left', async () => {
  const q = [fail(503, 'api_error', { 'retry-after': '1' }), good()];
  const a = make(q, { timeouts: { deadlineMs: 5000, minAttemptMs: 4500 } });
  await assert.rejects(() => a.proxy.takeTurn(room(), 'A'), (e) => e.httpStatus === 503);
  assert.equal(a.fetch.calls.length, 1);
  assert.deepEqual(a.clock.sleeps, []);
  const b = make(q, { timeouts: { deadlineMs: 5000, minAttemptMs: 4000 } });
  await b.proxy.takeTurn(room(), 'A');
  assert.deepEqual(b.clock.sleeps, [1000]);
});

test('the default minAttemptMs is 15 seconds', async () => {
  const { proxy, fetch } = make([fail(503, 'api_error', { 'retry-after': '1' }), good()], { timeouts: { deadlineMs: 15500 } });
  await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e.httpStatus === 503);
  assert.equal(fetch.calls.length, 1);
});

test('every terminal failure logs one proxy.failed with the status; a retried-out call logs gave_up instead', async () => {
  const count = (cap, ev) => cap.lines.filter((l) => l.includes(`event="${ev}"`)).length;
  const a = make([fail(401, 'authentication_error')]);
  await assert.rejects(() => a.proxy.takeTurn(room(), 'A'));
  assert.equal(count(a.cap, 'proxy.failed'), 1);
  assert.match(a.cap.lines[0], /httpStatus=401 /);
  const b = make([fail(503, 'api_error')]);
  await assert.rejects(() => b.proxy.mapAuthority(room(), ['t']));
  assert.equal(count(b.cap, 'proxy.failed'), 1);
  const c = make([reply(200, { content: [{ type: 'text', text: 'nope' }] })]);
  await assert.rejects(() => c.proxy.takeTurn(room(), 'A'), (e) => e instanceof ProxyError && e.message === 'Proxy did not return JSON');
  assert.equal(count(c.cap, 'proxy.failed'), 1);
  const d = make([good()], { apiKey: '' });
  await assert.rejects(() => d.proxy.takeTurn(room(), 'A'));
  assert.equal(count(d.cap, 'proxy.failed'), 1);
  const e = make([fail(503, 'api_error')]);
  await assert.rejects(() => e.proxy.takeTurn(room(), 'A'));
  assert.equal(count(e.cap, 'proxy.failed'), 0);
  assert.equal(count(e.cap, 'proxy.gave_up'), 1);
});

test('what beforeCall throws propagates unchanged, with kind, no log and no fetch', async () => {
  const thrown = Object.assign(new Error('budget'), { code: 429 });
  const kinds = [];
  const { proxy, fetch, cap } = make([good()], { beforeCall: (rm, kind) => { kinds.push(kind); throw thrown; } });
  await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e === thrown);
  await assert.rejects(() => proxy.draftCard({ room: room(), name: 'a', role: '', topic: 't', text: 'x' }), (e) => e === thrown);
  await assert.rejects(() => proxy.mapAuthority(room(), ['t']), (e) => e === thrown);
  assert.deepEqual(kinds, ['turn', 'draft', 'authority']);
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(cap.lines, []);
});

test('a TypeError, an unknown code and UND_ERR_SOCKET are not retried', async () => {
  for (const make1 of [() => new TypeError('fetch failed'), () => connError('UND_ERR_SOCKET'), () => connError('ECONNRESET'), () => connError('ETIMEDOUT'), () => connError('lower')]) {
    const { proxy, fetch } = make([() => { throw make1(); }, good()]);
    await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e instanceof ProxyError && e.message === 'Claude API request failed');
    assert.equal(fetch.calls.length, 1);
  }
});

test('the vetted code is carried as cause, never the raw error or its message', async () => {
  // the raw cause has the key as an own enumerable property: carrying it over would leak it
  const raw = Object.assign(new Error(KEY), { code: 'UND_ERR_SOCKET', message: KEY });
  const { proxy } = make([() => { throw Object.assign(new TypeError(KEY), { cause: raw }); }]);
  let caught = null;
  try { await proxy.takeTurn(room(), 'A'); } catch (e) { caught = e; }
  assert.ok(caught instanceof ProxyError);
  assert.deepEqual(Object.getOwnPropertyNames(caught.cause), ['code']);
  assert.equal(caught.cause.code, 'UND_ERR_SOCKET');
  assert.ok(!util.inspect(caught, { depth: 5 }).includes(KEY));
  const bad = make([() => { throw connError('bad code with spaces'); }]);
  await assert.rejects(() => bad.proxy.takeTurn(room(), 'A'), (e) => e.cause === undefined);
});

test('a 200 that is null, has non-array content or null blocks is a ProxyError and is not retried', async () => {
  for (const body of [null, { content: 'x' }, { content: [null] }, 'text', []]) {
    const { proxy, fetch } = make([reply(200, body), good()]);
    await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e instanceof ProxyError && e.message === 'Proxy did not return JSON', JSON.stringify(body));
    assert.equal(fetch.calls.length, 1);
  }
});

test('a json() that throws synchronously, or a 500 with a null body, still ends as a ProxyError', async () => {
  const sync = make([() => ({ ok: true, status: 200, headers: { get: () => null }, json: () => { throw new TypeError('sync'); } })]);
  await assert.rejects(() => sync.proxy.takeTurn(room(), 'A'), (e) => e instanceof ProxyError && e.message === 'Claude API request failed');
  assert.equal(sync.cap.lines.filter((l) => l.includes('event="proxy.failed"')).length, 1);
  const nul = make([reply(401, null)]);
  await assert.rejects(() => nul.proxy.takeTurn(room(), 'A'), (e) => e instanceof ProxyError && e.message === 'Claude API 401: request failed');
});

test('ProxyError lives in lib/errors and is re-exported by lib/proxy', () => {
  assert.equal(require('../lib/errors').ProxyError, require('../lib/proxy').ProxyError);
});

test('retry-after as an HTTP date: far out gives up, near waits about that long', async () => {
  const clock = fakeClock();
  const date = (ms) => new Date(clock.t + ms).toUTCString();
  const far = make([fail(429, 'rate_limit_error', { 'retry-after': date(60000) }), good()]);
  await assert.rejects(() => far.proxy.takeTurn(room(), 'A'), (e) => e.httpStatus === 429);
  assert.equal(far.fetch.calls.length, 1);
  const near = fakeClock();
  const fetch = fakeFetch([() => reply(429, { error: { type: 'rate_limit_error' } }, { 'retry-after': new Date(near.t + 2000).toUTCString() }), good()]);
  const p = createProxy({ apiKey: KEY, model: 'm', fetch, clock: near });
  await p.takeTurn(room(), 'A');
  assert.deepEqual(near.sleeps, [2000]);
});

test("retry-after: 0 still backs off with jitter", async () => {
  const orig = Math.random;
  Math.random = () => 0.5;
  try {
    const { proxy, clock } = make([fail(429, 'rate_limit_error', { 'retry-after': '0' }), good()]);
    await proxy.takeTurn(room(), 'A');
    assert.deepEqual(clock.sleeps, [500]);
  } finally { Math.random = orig; }
});

test('backoff doubles with full jitter: random 0.5 gives sleeps of 500 then 1000', async () => {
  const orig = Math.random;
  Math.random = () => 0.5;
  try {
    const { proxy, clock } = make([fail(503, 'api_error'), fail(503, 'api_error'), good()], { timeouts: { baseBackoffMs: 1000 } });
    await proxy.takeTurn(room(), 'A');
    assert.deepEqual(clock.sleeps, [500, 1000]);
  } finally { Math.random = orig; }
});

test('the attempt timer is clamped to the deadline', { timeout: 5000 }, async () => {
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const started = Date.now();
  const proxy = createProxy({ apiKey: KEY, model: 'm', fetch: fakeFetch([hang]), timeouts: { deadlineMs: 30, attemptMs: 60000 } });
  await assert.rejects(() => proxy.takeTurn(room(), 'A'), (e) => e instanceof ProxyError && /timed out/.test(e.message));
  assert.ok(Date.now() - started < 3000);
});

test('a partial clock falls back per field', async () => {
  const slept = [];
  const fetch = fakeFetch([fail(503, 'api_error'), good()]);
  // now is present but undefined: an Object.assign merge would overwrite the Date.now default with undefined
  const proxy = createProxy({ apiKey: KEY, model: 'm', fetch, clock: { now: undefined, sleep: async (ms) => { slept.push(ms); } } });
  assert.deepEqual(await proxy.takeTurn(room(), 'A'), { message: 'hi' });
  assert.equal(slept.length, 1);
});

test('a fractional retry-after in seconds is honoured', async () => {
  const { proxy, clock } = make([fail(429, 'rate_limit_error', { 'retry-after': '1.5' }), good()]);
  await proxy.takeTurn(room(), 'A');
  assert.deepEqual(clock.sleeps, [1500]);
});
