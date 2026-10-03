'use strict';
// The NEW config variables are strict: an invalid value throws a ConfigError whose code names the variable.
const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const { loadConfig, ConfigError, strictInt } = require('../lib/config');
const { TRUST_MODES } = require('../lib/net');
const { createLog, errorFields } = require('../lib/log');

const MARKER = 'zq9-MARKERVALUE';
const STRICT = [['ROOM_TTL_DAYS', 'roomTtlDays', 30, 3650], ['DEMO_TTL_HOURS', 'demoTtlHours', 24, 87600], ['MAX_ROOMS', 'maxRooms', 5000, 1000000]];

for (const [envName, key, dflt, max] of STRICT) {
  test(`${envName} is strict: default when blank, plain positive integers only`, () => {
    for (const blank of [undefined, '', '  ', '\t']) assert.equal(loadConfig({ [envName]: blank })[key], dflt, JSON.stringify(blank));
    assert.equal(loadConfig({ [envName]: '7' })[key], 7);
    assert.equal(loadConfig({ [envName]: ' 7 ' })[key], 7);
    assert.equal(loadConfig({ [envName]: String(max) })[key], max);
    for (const over of [String(max + 1), String(Number.MAX_SAFE_INTEGER)]) {
      assert.throws(() => loadConfig({ [envName]: over }), (e) => e instanceof ConfigError && e.code === 'BAD_' + envName, over);
    }
    const bad = ['0', '-1', '1.5', '1.0', '1e3', '0x10', 'Infinity', 'NaN', 'abc', '7x', '7 7', '+7', '9007199254740992', '99999999999999999999'];
    for (const b of bad) {
      assert.throws(() => loadConfig({ [envName]: b }), (e) => e instanceof ConfigError && e.code === 'BAD_' + envName, b);
    }
  });

  test(`${envName} errors never echo the value and the code fits the logger`, () => {
    for (const b of [MARKER, '0' + MARKER, '-' + MARKER]) {
      let err;
      try { loadConfig({ [envName]: b }); } catch (e) { err = e; }
      assert.ok(err instanceof ConfigError);
      assert.equal(err.name, 'ConfigError');
      assert.equal(errorFields(err).code, 'BAD_' + envName); // the logger accepts the code as-is
      assert.ok(err.message.includes(envName));
      for (const text of [err.message, util.inspect(err), String(err), JSON.stringify(err)]) assert.ok(!text.includes(MARKER), text);
    }
  });
}

test('TRUST_PROXY accepts only never, private or always, lowercase', () => {
  for (const blank of [undefined, '', '  ']) assert.equal(loadConfig({ TRUST_PROXY: blank }).trustProxy, 'private');
  for (const ok of TRUST_MODES) {
    assert.equal(loadConfig({ TRUST_PROXY: ok }).trustProxy, ok);
    assert.equal(loadConfig({ TRUST_PROXY: ` ${ok} ` }).trustProxy, ok);
  }
  for (const bad of ['Never', 'PRIVATE', 'Always', 'true', '1', 'yes', 'alway', 'private,always']) {
    assert.throws(() => loadConfig({ TRUST_PROXY: bad }), (e) => e instanceof ConfigError && e.code === 'BAD_TRUST_PROXY', bad);
  }
  let err;
  try { loadConfig({ TRUST_PROXY: MARKER }); } catch (e) { err = e; }
  assert.equal(err.code, 'BAD_TRUST_PROXY');
  for (const text of [err.message, util.inspect(err), String(err)]) assert.ok(!text.includes(MARKER), text);
});

test('strictInt refuses to run without a max', () => {
  for (const max of [undefined, null, NaN, Infinity, 1.5, '10']) {
    assert.throws(() => strictInt({ X: '1' }, 'X', 5, max), (e) => e instanceof Error && !(e instanceof ConfigError) && e.message === 'strictInt needs a max', String(max));
  }
  assert.equal(strictInt({ X: '3' }, 'X', 5, 10), 3);
});

test('valid values are returned for every new key', () => {
  const c = loadConfig({ ROOM_TTL_DAYS: '5', DEMO_TTL_HOURS: '2', MAX_ROOMS: '10', TRUST_PROXY: 'always' });
  assert.equal(c.roomTtlDays, 5);
  assert.equal(c.demoTtlHours, 2);
  assert.equal(c.maxRooms, 10);
  assert.equal(c.trustProxy, 'always');
});

test('app.init_failed names the bad variable through the code field and never the value', () => {
  const out = [];
  const log = createLog({ stream: { write: (s) => out.push(s) } });
  let err;
  try { loadConfig({ MAX_ROOMS: MARKER }); } catch (e) { err = e; }
  log.error('app.init_failed', {}, err);
  const line = out.join('');
  assert.ok(line.includes('event="app.init_failed"'), line);
  assert.ok(line.includes('code="BAD_MAX_ROOMS"'), line);
  assert.ok(line.includes('errorClass="ConfigError"'), line);
  assert.ok(!line.includes(MARKER), line);
});
