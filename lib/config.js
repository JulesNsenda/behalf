'use strict';
// Reads the environment once. Existing variables keep their original semantics: `Number(x) || default`, so 0, empty,
// whitespace and garbage all fall back to the default. The config object holds only primitive inputs; callers derive
// paths from dataDir and ROOT. Secrets are deliberately NOT part of the config object: they come from loadSecrets().
// Pass the secrets object whole; never spread or merge it.
const path = require('path');
const util = require('util');
const { parsePort } = require('./port');

const ROOT = path.join(__dirname, '..');

function loadConfig(env = process.env) {
  return Object.freeze({
    port: parsePort(env.PORT),
    bindHost: env.BIND_HOST, // not HOST: csh-style shells export that as the machine name
    dataDir: env.DROP_DATA_DIR || path.join(ROOT, '.data'),
    dailyRoomLimit: Number(env.DAILY_ROOM_LIMIT) || 20,
    perIpDaily: Number(env.PER_IP_DAILY) || 3,
    maxTurns: Number(env.MAX_TURNS) || 10,
    demoDelayMs: Number(env.DEMO_DELAY_MS) || 2600,
    publicUrl: (env.PUBLIC_URL || 'https://proxy-room.dropkit.sh').replace(/\/$/, ''),
    model: env.PXP_MODEL || 'claude-sonnet-5-5',
  });
}

const REDACTED = '[redacted]';

function loadSecrets(env = process.env) {
  const secrets = { passcode: env.ROOM_PASSCODE || '', apiKey: env.ANTHROPIC_API_KEY || '' };
  // The value stays readable, but JSON.stringify, util.inspect and console.log only ever show the redacted form.
  const redacted = () => ({ passcode: REDACTED, apiKey: REDACTED });
  Object.defineProperty(secrets, 'toJSON', { value: redacted });
  Object.defineProperty(secrets, util.inspect.custom, { value: redacted });
  return Object.freeze(secrets);
}

module.exports = { loadConfig, loadSecrets, ROOT };
