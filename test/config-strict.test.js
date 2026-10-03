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

test('DRAIN_DEADLINE_MS is strict, 100 to 9000 (under the platform\'s kill timeout), and defaults to 4000', () => {
  for (const blank of [undefined, '', '  ']) assert.equal(loadConfig({ DRAIN_DEADLINE_MS: blank }).drainDeadlineMs, 4000);
  assert.equal(loadConfig({}).drainDeadlineMs, 4000);
  assert.equal(loadConfig({ DRAIN_DEADLINE_MS: '100' }).drainDeadlineMs, 100);
  assert.equal(loadConfig({ DRAIN_DEADLINE_MS: ' 9000 ' }).drainDeadlineMs, 9000);
  for (const bad of ['99', '0', '9001', '10000', '-1', '1.5', 'abc', '400ms', MARKER]) {
    assert.throws(() => loadConfig({ DRAIN_DEADLINE_MS: bad }), (e) => e instanceof ConfigError && e.code === 'BAD_DRAIN_DEADLINE_MS' && !e.message.includes(MARKER), bad);
  }
  assert.equal(strictInt({ X: '3' }, 'X', 5, 10, 3), 3);
  assert.throws(() => strictInt({ X: '2' }, 'X', 5, 10, 3), ConfigError);
});

// ---- sign-in ----
const { loadSecrets, consumeSecrets, checkSignin } = require('../lib/config');

test('SIGNIN defaults to off with no data dir or database url, and must be explicit when DROP_DATA_DIR or DATABASE_URL is set', () => {
  for (const blank of [undefined, '', '  ']) assert.equal(loadConfig({ SIGNIN: blank }).signin, 'off', JSON.stringify(blank));
  for (const blank of [undefined, '', '  ']) {
    assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://u:p@h/d', SIGNIN: blank }), (e) => e instanceof ConfigError && e.code === 'BAD_SIGNIN', 'DATABASE_URL alone: ' + JSON.stringify(blank));
    assert.throws(() => loadConfig({ DROP_DATA_DIR: '/data', SIGNIN: blank }), (e) => e instanceof ConfigError && e.code === 'BAD_SIGNIN', JSON.stringify(blank));
  }
  assert.equal(loadConfig({ DROP_DATA_DIR: '/data', SIGNIN: 'off' }).signin, 'off');
  assert.equal(loadConfig({ DROP_DATA_DIR: '/data', SIGNIN: 'github' }).signin, 'github');
  assert.equal(loadConfig({ SIGNIN: ' github ' }).signin, 'github');
  for (const bad of ['GitHub', 'GITHUB', 'on', 'true', '1', 'google', 'github,off', MARKER]) {
    assert.throws(() => loadConfig({ SIGNIN: bad }), (e) => e instanceof ConfigError && e.code === 'BAD_SIGNIN' && !e.message.includes(MARKER), bad);
  }
});

test('SIGNIN=github needs both GitHub secrets (BAD_SIGNIN_SECRETS) and an https PUBLIC_URL, or http for localhost (BAD_PUBLIC_URL)', () => {
  const github = loadConfig({ SIGNIN: 'github', PUBLIC_URL: 'https://x.test' });
  const full = loadSecrets({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'sec' });
  assert.doesNotThrow(() => checkSignin(github, full));
  for (const partial of [{}, { GITHUB_CLIENT_ID: 'id' }, { GITHUB_CLIENT_SECRET: 'sec' }, { GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: 'sec' }]) {
    assert.throws(() => checkSignin(github, loadSecrets(partial)), (e) => e instanceof ConfigError && e.code === 'BAD_SIGNIN_SECRETS', JSON.stringify(partial));
  }
  for (const url of ['not a url', 'ftp://x.test', 'javascript:alert(1)', 'http://x.test', 'http://behalf.dropkit.sh', 'http://localhost.evil.test', 'http://127.0.0.2:3000']) {
    assert.throws(() => checkSignin(loadConfig({ SIGNIN: 'github', PUBLIC_URL: url }), full), (e) => e instanceof ConfigError && e.code === 'BAD_PUBLIC_URL', url);
  }
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:3000', 'https://x.test']) assert.doesNotThrow(() => checkSignin(loadConfig({ SIGNIN: 'github', PUBLIC_URL: url }), full), url);
  // The secrets are checked first, so the code says which one is wrong.
  assert.throws(() => checkSignin(loadConfig({ SIGNIN: 'github', PUBLIC_URL: 'http://x.test' }), loadSecrets({})), (e) => e.code === 'BAD_SIGNIN_SECRETS');
  assert.doesNotThrow(() => checkSignin(loadConfig({ SIGNIN: 'off' }), loadSecrets({})), 'off needs nothing');
});

test('PER_USER_DAILY is a strict integer, default 3', () => {
  for (const blank of [undefined, '', '  ']) assert.equal(loadConfig({ PER_USER_DAILY: blank }).perUserDaily, 3);
  assert.equal(loadConfig({ PER_USER_DAILY: ' 7 ' }).perUserDaily, 7);
  assert.equal(loadConfig({ PER_USER_DAILY: '1000' }).perUserDaily, 1000);
  for (const bad of ['0', '-1', '1.5', '1e3', 'abc', '1001', MARKER]) {
    assert.throws(() => loadConfig({ PER_USER_DAILY: bad }), (e) => e instanceof ConfigError && e.code === 'BAD_PER_USER_DAILY' && !e.message.includes(MARKER), bad);
  }
});

test('GITHUB_BLOCKED_IDS is a comma-separated list of numeric ids, strict', () => {
  for (const blank of [undefined, '', '  ']) assert.deepEqual([...loadConfig({ GITHUB_BLOCKED_IDS: blank }).githubBlockedIds], []);
  assert.deepEqual([...loadConfig({ GITHUB_BLOCKED_IDS: '42' }).githubBlockedIds], ['42']);
  assert.deepEqual([...loadConfig({ GITHUB_BLOCKED_IDS: ' 42 , 7,0042 ' }).githubBlockedIds], ['42', '7', '42']);
  assert.ok(Object.isFrozen(loadConfig({ GITHUB_BLOCKED_IDS: '1' }).githubBlockedIds));
  for (const bad of ['abc', '1,', ',1', '1,,2', '-1', '1.5', '0', '1e3', '0x10', '1 2', '1234567890123456', 'octocat', MARKER]) {
    assert.throws(() => loadConfig({ GITHUB_BLOCKED_IDS: bad }), (e) => e instanceof ConfigError && e.code === 'BAD_GITHUB_BLOCKED_IDS' && !e.message.includes(MARKER), bad);
  }
});

test('the GitHub secrets are redacted, kept out of the config, and removed from the environment', () => {
  const env = { GITHUB_CLIENT_ID: 'cid-VALUE', GITHUB_CLIENT_SECRET: 'csec-VALUE', KEEP: '1' };
  const config = loadConfig(env);
  for (const text of [JSON.stringify(config), util.inspect(config, { depth: 5, showHidden: true })]) assert.ok(!text.includes('VALUE'), text);
  const s = consumeSecrets(env);
  assert.deepEqual([s.githubClientId, s.githubClientSecret], ['cid-VALUE', 'csec-VALUE']);
  assert.deepEqual(env, { KEEP: '1' });
  for (const text of [JSON.stringify(s), util.inspect(s, { showHidden: true }), util.format('%o', s)]) assert.ok(!text.includes('VALUE'), text);
});
