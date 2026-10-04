'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const path = require('node:path');
const { loadConfig, loadSecrets, ROOT } = require('../lib/config');

const SECRET_PASS = 'hunter2-PASSVALUE';

test('defaults with an empty environment', () => {
  const c = loadConfig({});
  assert.deepEqual({ ...c }, {
    port: 3000,
    bindHost: undefined,
    dataDir: path.join(ROOT, '.data'),
    dailyRoomLimit: 20,
    perIpDaily: 3,
    maxTurns: 10,
    demoDelayMs: 2600,
    roomTtlDays: 30,
    demoTtlHours: 24,
    maxRooms: 5000,
    trustProxy: 'private',
    publicUrl: 'https://behalf.dropkit.sh',
    model: 'claude-sonnet-5-5',
    drainDeadlineMs: 4000,
    signin: 'off',
    perUserDaily: 3,
    githubBlockedIds: [],
    requireDatabase: false,
  });
  assert.equal(ROOT, path.join(__dirname, '..'));
});

// Existing numeric variables: `Number(x) || default`.
for (const [envName, key, dflt] of [['DAILY_ROOM_LIMIT', 'dailyRoomLimit', 20], ['PER_IP_DAILY', 'perIpDaily', 3], ['MAX_TURNS', 'maxTurns', 10], ['DEMO_DELAY_MS', 'demoDelayMs', 2600]]) {
  test(`${envName} keeps the Number(x) || default semantics`, () => {
    for (const bad of ['0', '', '  ', 'abc', 'NaN']) assert.equal(loadConfig({ [envName]: bad })[key], dflt, JSON.stringify(bad));
    assert.equal(loadConfig({ [envName]: '7' })[key], 7);
    assert.equal(loadConfig({ [envName]: ' 7 ' })[key], 7);
  });
}

test('PORT keeps parsePort semantics, 0 stays valid', () => {
  assert.equal(loadConfig({ PORT: '8080' }).port, 8080);
  assert.equal(loadConfig({ PORT: '0' }).port, 0);
  for (const bad of ['', '  ', 'abc', '70000', '-1']) assert.equal(loadConfig({ PORT: bad }).port, 3000, bad);
});

test('string variables fall back when empty, keep their value otherwise', () => {
  assert.equal(loadConfig({ DROP_DATA_DIR: '' }).dataDir, path.join(ROOT, '.data'));
  const c = loadConfig({ DROP_DATA_DIR: path.join(ROOT, 'x'), SIGNIN: 'off', BIND_HOST: '127.0.0.1' });
  assert.equal(c.dataDir, path.join(ROOT, 'x'));
  assert.equal(c.bindHost, '127.0.0.1');
});

test('PUBLIC_URL loses one trailing slash; empty gives the default', () => {
  assert.equal(loadConfig({ PUBLIC_URL: 'https://x.test/' }).publicUrl, 'https://x.test');
  assert.equal(loadConfig({ PUBLIC_URL: 'https://x.test' }).publicUrl, 'https://x.test');
  assert.equal(loadConfig({ PUBLIC_URL: '' }).publicUrl, 'https://behalf.dropkit.sh');
});

test('the config object is frozen', () => {
  const c = loadConfig({});
  assert.ok(Object.isFrozen(c));
  assert.throws(() => { c.port = 1; }, TypeError);
});

test('secrets are not in the config, its JSON or its inspect output', () => {
  const c = loadConfig({ ROOM_PASSCODE: SECRET_PASS });
  for (const text of [JSON.stringify(c), util.inspect(c, { depth: 5, showHidden: true })]) {
    assert.ok(!text.includes(SECRET_PASS));
  }
  assert.ok(!('passcode' in c));
});

test('secrets keep readable values but redact them in JSON and inspect', () => {
  const s = loadSecrets({ ROOM_PASSCODE: SECRET_PASS });
  assert.ok(Object.isFrozen(s));
  assert.equal(s.passcode, SECRET_PASS);
  for (const text of [JSON.stringify(s), util.inspect(s, { showHidden: true }), util.format('%o', s), JSON.stringify({ s })]) {
    assert.ok(!text.includes(SECRET_PASS), text);
  }
  assert.match(JSON.stringify(s), /\[redacted\]/);
  assert.match(util.inspect(s), /\[redacted\]/);
  assert.equal(loadSecrets({}).passcode, '');
});

test('the API key is a redacted secret and the model is plain config', () => {
  const KEY = 'sk-ant-KEYVALUE-1234';
  const s = loadSecrets({ ANTHROPIC_API_KEY: KEY });
  assert.equal(s.apiKey, KEY);
  for (const text of [JSON.stringify(s), util.inspect(s, { showHidden: true }), util.format('%o', s)]) assert.ok(!text.includes(KEY), text);
  assert.equal(loadSecrets({}).apiKey, '');
  const c = loadConfig({ ANTHROPIC_API_KEY: KEY });
  assert.ok(!JSON.stringify(c).includes(KEY) && !('apiKey' in c));
  assert.equal(loadConfig({ PXP_MODEL: 'm-1' }).model, 'm-1');
  assert.equal(loadConfig({ PXP_MODEL: '' }).model, 'claude-sonnet-5-5');
});
