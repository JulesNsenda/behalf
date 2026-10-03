'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLog, errorFields, ALLOWED } = require('../lib/log');

function capture() {
  const lines = [];
  const stream = { write: (s) => { lines.push(s); } };
  return { lines, log: createLog({ stream }) };
}

test('the allowlist is pinned', () => {
  assert.deepEqual(ALLOWED, ['room', 'seat', 'status', 'httpStatus', 'errorClass', 'code', 'durationMs', 'stack', 'reason', 'kind']);
});

test('one line per call: level, event and allowlisted fields, JSON-escaped', () => {
  const { lines, log } = capture();
  log.error('store.save_failed', { room: 'abc', httpStatus: 500 }, new TypeError('m'));
  log.info('x', {});
  log.warn('y');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^level=error event="store\.save_failed" room="abc" httpStatus=500 errorClass="TypeError" stack=".+"\n$/);
  assert.equal(lines[1], 'level=info event="x"\n');
  assert.equal(lines[2], 'level=warn event="y"\n');
});

test('keys outside the allowlist, including message, are dropped silently', () => {
  const { lines, log } = capture();
  log.info('e', { room: 'r1', message: 'MSGVALUE', token: 'TOKENVALUE', url: '/x?t=SECRET', card: 'CARD', answer: 'A' });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('room="r1"'));
  for (const bad of ['MSGVALUE', 'TOKENVALUE', 'SECRET', 'CARD', 'token', 'url', 'message']) assert.ok(!lines[0].includes(bad), bad);
});

test('errorClass, code and stack in caller fields are always dropped; only the error argument supplies them', () => {
  const { lines, log } = capture();
  log.error('e', { room: 'r', errorClass: 'FORGEDCLASS', code: 'FORGED_CODE', stack: '    at FORGED (x.js:1:1)' });
  assert.equal(lines[0], 'level=error event="e" room="r"\n');
  const err = new Error('m');
  err.code = 'ECONNRESET';
  log.error('e', { room: 'r', errorClass: 'FORGEDCLASS', code: 'FORGED_CODE', stack: '    at FORGED (x.js:1:1)' }, err);
  assert.ok(!lines[1].includes('FORGED'), lines[1]);
  assert.ok(lines[1].includes('errorClass="Error"') && lines[1].includes('code="ECONNRESET"') && lines[1].includes(' stack='));
});

const SEPS = [String.fromCharCode(0x85), String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
test('newlines, quotes and Unicode line separators cannot start a second line', () => {
  const { lines, log } = capture();
  log.error('e\nlevel=error event="fake"', { room: 'a\nlevel=error event="forged"\r' + SEPS.join('') + 'b' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].match(/\n/g).length, 1);
  assert.ok(lines[0].endsWith('\n'));
  for (const raw of ['\r', ...SEPS]) assert.ok(!lines[0].includes(raw), JSON.stringify(raw));
  assert.ok(lines[0].includes(String.fromCharCode(92) + 'u2028'));
});

test('a value whose toString throws does not throw out of the logger', () => {
  const { log } = capture();
  const bad = { toString() { throw new Error('nope'); } };
  assert.doesNotThrow(() => log.error('e', { room: bad }));
  assert.doesNotThrow(() => log.error(bad, { room: 'r' }));
});

test('a throwing stream never throws out of the logger', () => {
  const log = createLog({ stream: { write() { throw new Error('closed'); } } });
  assert.doesNotThrow(() => log.error('e', { room: 'r' }, new Error('m')));
});

test('the error argument never leaks its message, even when it looks like a stack frame', () => {
  const { lines, log } = capture();
  log.error('e', {}, new Error('x\n    at LEAK'));
  assert.ok(!lines[0].includes('LEAK'), lines[0]);
  const f = errorFields(new TypeError('MODEL-OUTPUT-LEAK {"card":"theirs"}\nline two LEAK2'));
  assert.equal(f.errorClass, 'TypeError');
  assert.ok(f.stack && /^\s+at /.test(f.stack));
  assert.ok(!f.stack.includes('LEAK'));
});

test('a message mutated after construction (wrong newline count) still cannot leak a fake frame', () => {
  const { lines, log } = capture();
  const e = new Error('short\n    at SECRET (a.js:1:1)');
  const before = e.stack;
  assert.ok(before.includes('at SECRET (a.js:1:1)'));
  e.message = 'changed';
  log.error('e', {}, e);
  assert.ok(!lines[0].includes('SECRET'), lines[0]);
  const e2 = new Error('short\n    at SECRET (a.js:1:1)\nmore');
  e2.message = 'short\n    at SECRET (a.js:1:1)';
  log.error('e', {}, e2);
  assert.ok(!lines[1].includes('SECRET'), lines[1]);
});

test('U+202E and other non-ASCII characters in a value are escaped', () => {
  const { lines, log } = capture();
  log.error('e', { room: 'a' + String.fromCharCode(0x202e) + 'b' + String.fromCharCode(0xe9) + String.fromCharCode(7) });
  assert.ok(/^[\x20-\x7e]*\n$/.test(lines[0]), lines[0]);
  assert.ok(lines[0].includes(String.fromCharCode(92) + 'u202e'));
});

test('a real JSON.parse error does not leak the text it was parsing', () => {
  const { lines, log } = capture();
  let err;
  try { JSON.parse('{"a": tru\n    at CARD_SECRET}'); } catch (e) { err = e; }
  assert.ok(err instanceof SyntaxError);
  log.error('e', {}, err);
  assert.ok(!lines[0].includes('CARD_SECRET'), lines[0]);
  assert.ok(lines[0].includes('errorClass="SyntaxError"'));
});

test('errorFields keeps only full V8 frame shapes, as one contiguous run at the end', () => {
  const e = new Error('m');
  e.stack = [
    'Error: m',
    '    at LEAK (a.js:1:1)',
    'SECRET line',
    '    at fn (/app/a.js:1:2)',
    '    at async next (/app/b.js:3:4)',
    '    at new Thing (/app/c.js:5:6)',
    '    at /app/d.js:7:8',
    '    at Array.map (<anonymous>)',
    '    at Object.<anonymous> (/app/e.js:1:1)',
    '    at Module._compile (node:internal/modules/cjs/loader:1554:14)',
    '    at node:internal/process/task_queues:95:5',
    '    at async /app/f.js:2:2',
  ].join('\n');
  const stack = errorFields(e).stack;
  assert.equal(stack.split('\n').length, 9);
  assert.ok(!stack.includes('LEAK') && !stack.includes('SECRET'));
});

test('a computed-name frame with parentheses or odd characters in the name is dropped', () => {
  const e = new Error('m');
  e.stack = 'Error: m\n    at real (/app/a.js:1:2)\n    at Object.[SECRET (x)] (/app/b.js:1:1)\n    at fn (/app/c.js:1:1)';
  assert.ok(!errorFields(e).stack.includes('SECRET'));
  assert.ok(!errorFields(e).stack.includes('real'), 'the run stops at the first non-frame, walking back from the end');
  const e2 = new Error('m');
  e2.stack = 'Error: m\n    at fn (SECRET "x" y) (/app/c.js:1:1)';
  assert.equal(errorFields(e2).stack, undefined);
});

test('stack is omitted unless the header equals name: message exactly', () => {
  const e = new Error('m');
  e.stack = 'Error: other\n    at fn (/app/a.js:1:1)';
  assert.equal(errorFields(e).stack, undefined);
  const noMsg = new Error('');
  assert.ok(errorFields(noMsg).stack, 'an empty message gives a name-only header');
});

test('errorFields fails closed when no line is a real frame', () => {
  const e = new Error('m');
  e.stack = 'Error: m\nSECRET not a frame\n    at LEAK';
  assert.equal(errorFields(e).stack, undefined);
  e.stack = 'no newline at all SECRET';
  assert.equal(errorFields(e).stack, undefined);
});

test('errorFields strips [as ...] aliases from frames', () => {
  const e = new Error('m');
  e.stack = 'Error: m\n    at Object.foo [as SECRETKEY] (/app/file.js:1:1)';
  const f = errorFields(e);
  assert.ok(f.stack && f.stack.includes('Object.foo'));
  assert.ok(!f.stack.includes('SECRETKEY'));
});

test('errorFields reports a valid error code, from the error or its cause; others are dropped', () => {
  const a = new Error('m');
  a.code = 'ECONNRESET';
  assert.equal(errorFields(a).code, 'ECONNRESET');
  const b = new Error('m', { cause: { code: 'UND_ERR_SOCKET' } });
  assert.equal(errorFields(b).code, 'UND_ERR_SOCKET');
  for (const bad of ['lower', 'E', 'HAS SPACE', 'X\nY', 'A'.repeat(50), 42]) {
    const e = new Error('m');
    e.code = bad;
    assert.equal(errorFields(e).code, undefined, String(bad));
  }
});

test('errorFields survives odd inputs, hostile names and throwing getters', () => {
  assert.equal(errorFields(undefined).errorClass, 'Error');
  assert.equal(errorFields('boom').errorClass, 'Error');
  const e = new Error('m');
  e.name = 'Evil\nlevel=error';
  assert.equal(errorFields(e).errorClass, 'Error');
  const g = { get name() { throw new Error('x'); } };
  assert.deepEqual(errorFields(g), { errorClass: 'Error' });
});

test('kind accepts only a store record kind, and a login, a user id or a token cannot ride in it', () => {
  const { lines, log } = capture();
  for (const k of ['room', 'user', 'session', 'agentkey', 'usage', 'meta']) log.info('x', { kind: k });
  assert.deepEqual(lines, ['room', 'user', 'session', 'agentkey', 'usage', 'meta'].map((k) => `level=info event="x" kind="${k}"\n`));
  lines.length = 0;
  for (const bad of ['octocat', '12345', 'Session', 'bh_abc', '', 7, null, {}]) log.info('x', { kind: bad });
  assert.ok(lines.every((l) => l === 'level=info event="x"\n'), lines.join(''));
});

test('auth events carry the error class and code of an AuthError and nothing from GitHub', () => {
  const { AuthError } = require('../lib/errors');
  const { lines, log } = capture();
  log.error('auth.login_failed', {}, new AuthError('AUTH_EXCHANGE'));
  assert.match(lines[0], /^level=error event="auth\.login_failed" errorClass="AuthError" code="AUTH_EXCHANGE" stack=".*"\n$/);
  assert.ok(!lines[0].includes('Sign-in failed'), 'the message is never logged');
});
