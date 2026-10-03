'use strict';
// Reads the environment once. Existing variables keep their original semantics: `Number(x) || default`, so 0, empty,
// whitespace and garbage all fall back to the default. The config object holds only primitive inputs; callers derive
// paths from dataDir and ROOT. Secrets are deliberately NOT part of the config object: they come from loadSecrets().
// Pass the secrets object whole; never spread or merge it.
const path = require('path');
const util = require('util');
const { parsePort } = require('./port');
const { TRUST_MODES } = require('./net');

const ROOT = path.join(__dirname, '..');

// NEW variables are strict: a bad value stops startup instead of silently falling back. The error names the variable
// through its code (BAD_<NAME>, which the logger allowlists) and never carries the value.
class ConfigError extends Error {
  constructor(varName) {
    super(`Invalid value for ${varName}`);
    this.name = 'ConfigError';
    this.code = 'BAD_' + varName;
  }
}

function strictInt(env, name, dflt, max) {
  if (!Number.isSafeInteger(max)) throw new Error('strictInt needs a max');
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  const s = String(raw).trim();
  const n = Number(s);
  if (!/^[0-9]+$/.test(s) || !Number.isSafeInteger(n) || n < 1 || n > max) throw new ConfigError(name);
  return n;
}

function strictMode(env, name, modes, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  const s = String(raw).trim();
  if (!modes.includes(s)) throw new ConfigError(name);
  return s;
}

function loadConfig(env = process.env) {
  return Object.freeze({
    port: parsePort(env.PORT),
    bindHost: env.BIND_HOST, // not HOST: csh-style shells export that as the machine name
    dataDir: env.DROP_DATA_DIR || path.join(ROOT, '.data'),
    dailyRoomLimit: Number(env.DAILY_ROOM_LIMIT) || 20,
    perIpDaily: Number(env.PER_IP_DAILY) || 3,
    maxTurns: Number(env.MAX_TURNS) || 10,
    demoDelayMs: Number(env.DEMO_DELAY_MS) || 2600,
    roomTtlDays: strictInt(env, 'ROOM_TTL_DAYS', 30, 3650),
    demoTtlHours: strictInt(env, 'DEMO_TTL_HOURS', 24, 87600),
    maxRooms: strictInt(env, 'MAX_ROOMS', 5000, 1000000),
    trustProxy: strictMode(env, 'TRUST_PROXY', TRUST_MODES, 'private'),
    publicUrl: (env.PUBLIC_URL || 'https://behalf.dropkit.sh').replace(/\/$/, ''),
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

module.exports = { loadConfig, loadSecrets, ConfigError, strictInt, ROOT } // strictInt: exported for its max-required test;
