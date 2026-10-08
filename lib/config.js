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

function strictInt(env, name, dflt, max, min = 1) {
  if (!Number.isSafeInteger(max)) throw new Error('strictInt needs a max');
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  const s = String(raw).trim();
  const n = Number(s);
  if (!/^[0-9]+$/.test(s) || !Number.isSafeInteger(n) || n < min || n > max) throw new ConfigError(name);
  return n;
}

function strictMode(env, name, modes, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  const s = String(raw).trim();
  if (!modes.includes(s)) throw new ConfigError(name);
  return s;
}

// The sign-in mode. Off the platform (no DROP_DATA_DIR and no DATABASE_URL) it defaults to off; on it, it must be set on purpose,
// so a deploy that forgot it fails at startup instead of opening live rooms to everyone.
function signinMode(env) {
  const raw = env.SIGNIN;
  if ((raw === undefined || raw === null || String(raw).trim() === '') && (env.DROP_DATA_DIR || env.DATABASE_URL)) throw new ConfigError('SIGNIN');
  return strictMode(env, 'SIGNIN', ['github', 'off'], 'off');
}

// A strict 1 or 0 flag; unset or empty is the default.
function strictFlag(env, name, dflt) {
  return strictMode(env, name, ['1', '0'], dflt ? '1' : '0') === '1';
}

// Comma-separated GitHub user ids (GITHUB_BLOCKED_IDS, ADMIN_GITHUB_IDS), digits only, no empty entry. Returned as a frozen array of
// canonical id strings.
function githubIds(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return Object.freeze([]);
  const ids = String(raw).split(',').map((p) => p.trim());
  for (const p of ids) if (!/^[0-9]{1,15}$/.test(p) || Number(p) < 1) throw new ConfigError(name);
  return Object.freeze(ids.map((p) => String(Number(p))));
}

// MAIL_FROM: `Name <address>` or a bare address. Returned as { name, address }; unset is null (smtp then refuses to start).
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL.test(s);
function mailFrom(env) {
  const raw = env.MAIL_FROM;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  const m = s.match(/^([^<>"\r\n]{0,80}?)\s*<([^<>\s]+)>$/);
  const name = m ? m[1].trim() : '';
  const address = m ? m[2] : s;
  if (s.length > 320 || !isEmail(address)) throw new ConfigError('MAIL_FROM');
  return Object.freeze({ name, address });
}

// ADMIN_EMAIL: one bare address, where the owner is told of a new "Use our AI" request. Unset is null (no notice).
function adminEmail(env) {
  const raw = env.ADMIN_EMAIL;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  if (!isEmail(s)) throw new ConfigError('ADMIN_EMAIL');
  return s;
}

// A host name or an IP literal, nothing else (no scheme, port or path).
function smtpHost(env) {
  const raw = env.SMTP_HOST;
  if (raw === undefined || raw === null || String(raw).trim() === '') return '';
  const s = String(raw).trim();
  if (s.length > 253 || !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]+\]$/.test(s)) throw new ConfigError('SMTP_HOST');
  return s;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
// Whether PUBLIC_URL is unset or names this machine (localhost, 127.0.0.1, [::1]); anything else, or a URL that does not parse, is not local.
function localPublicUrl(raw) {
  if (!raw) return true;
  try { return LOCAL_HOSTS.includes(new URL(raw).hostname); } catch { return false; }
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
    drainDeadlineMs: strictInt(env, 'DRAIN_DEADLINE_MS', 4000, 9000, 100), // Drop kills 5 s (PM2) or 10 s (Docker) after SIGTERM
    signin: signinMode(env),
    perUserDaily: strictInt(env, 'PER_USER_DAILY', 3, 1000),
    githubBlockedIds: githubIds(env, 'GITHUB_BLOCKED_IDS'),
    // The owner(s): always have "Use our AI" access and decide the requests of others (lib/ai-access.js). A dashboard setting only.
    adminGithubIds: githubIds(env, 'ADMIN_GITHUB_IDS'),
    // On by default on the platform (DROP_DATA_DIR set), so no setting has to reach the app for the guard to hold.
    requireDatabase: strictFlag(env, 'REQUIRE_DATABASE', Boolean(env.DROP_DATA_DIR)),
    // Email. dev writes each message to an outbox folder; smtp sends through SMTP_HOST (checkMail says what it needs).
    mailTransport: strictMode(env, 'MAIL_TRANSPORT', ['dev', 'smtp'], 'dev'),
    mailFrom: mailFrom(env),
    adminEmail: adminEmail(env), // a dashboard setting only; never in /api/config or /health
    smtpHost: smtpHost(env),
    smtpPort: strictInt(env, 'SMTP_PORT', 0, 65535),
    smtpSecure: strictMode(env, 'SMTP_SECURE', ['true', 'false'], ''), // '' = follow the port (465: true, else false)
    // The /dev/outbox page (and dev mail counting as deliverable) exists only off the platform AND on a local PUBLIC_URL: an outbox
    // holds live links, and a public self-hosted deploy has no business serving or writing them. An unset PUBLIC_URL is local dev.
    devOutbox: !(env.DROP_DATA_DIR || env.DATABASE_URL) && localPublicUrl(env.PUBLIC_URL),
  });
}

// Whether the sign-in settings can work: github needs both GitHub secrets (BAD_SIGNIN_SECRETS) and a PUBLIC_URL that is https, or
// http only for localhost (BAD_PUBLIC_URL): its origin is what a request's Origin header must equal, and the cookies are Secure.
// Needs the config and the secrets together, so it is its own step. (An unset SIGNIN that must be explicit is BAD_SIGNIN.)
function checkSignin(config, secrets) {
  if (config.signin !== 'github') return;
  if (!secrets.githubClientId || !secrets.githubClientSecret) throw new ConfigError('SIGNIN_SECRETS');
  let url = null;
  try { url = new URL(config.publicUrl); } catch { /* checked below */ }
  if (!url || !(url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname)))) throw new ConfigError('PUBLIC_URL');
}

// Whether the mail settings can work. smtp needs every SMTP setting and MAIL_FROM (BAD_SMTP_HOST, BAD_SMTP_PORT, BAD_SMTP_AUTH,
// BAD_MAIL_FROM), and refuses the two usual mix-ups of port and TLS mode (BAD_SMTP_SECURE): 465 is TLS from the first byte, 587
// starts in plain text and must upgrade with STARTTLS. dev needs nothing.
function checkMail(config, secrets) {
  if (config.mailTransport !== 'smtp') return;
  if (!config.smtpHost) throw new ConfigError('SMTP_HOST');
  if (!config.smtpPort) throw new ConfigError('SMTP_PORT');
  if (!secrets.smtpUser || !secrets.smtpPass) throw new ConfigError('SMTP_AUTH');
  if (!config.mailFrom) throw new ConfigError('MAIL_FROM');
  const secure = smtpSecure(config);
  if ((config.smtpPort === 465 && !secure) || (config.smtpPort === 587 && secure)) throw new ConfigError('SMTP_SECURE');
}

// SMTP_SECURE, or what the port implies when it is unset.
const smtpSecure = (config) => (config.smtpSecure ? config.smtpSecure === 'true' : config.smtpPort === 465);

const REDACTED = '[redacted]';

function loadSecrets(env = process.env) {
  const secrets = {
    passcode: env.ROOM_PASSCODE || '', apiKey: env.ANTHROPIC_API_KEY || '', databaseUrl: env.DATABASE_URL || '',
    githubClientId: env.GITHUB_CLIENT_ID || '', githubClientSecret: env.GITHUB_CLIENT_SECRET || '',
    smtpUser: env.SMTP_USER || '', smtpPass: env.SMTP_PASS || '',
  };
  // The value stays readable, but JSON.stringify, util.inspect and console.log only ever show the redacted form.
  const redacted = () => ({ passcode: REDACTED, apiKey: REDACTED, databaseUrl: REDACTED, githubClientId: REDACTED, githubClientSecret: REDACTED, smtpUser: REDACTED, smtpPass: REDACTED });
  Object.defineProperty(secrets, 'toJSON', { value: redacted });
  Object.defineProperty(secrets, util.inspect.custom, { value: redacted });
  return Object.freeze(secrets);
}

// The one list of secret names: read once and removed from the environment (defence in depth only: this clears process.env,
// not the kernel's copy of the environment block). Every entry point that reads secrets itself goes through here.
const SECRET_NAMES = ['ROOM_PASSCODE', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SMTP_USER', 'SMTP_PASS'];
function consumeSecrets(env = process.env) {
  const secrets = loadSecrets(env);
  for (const name of SECRET_NAMES) delete env[name];
  return secrets;
}

module.exports = { loadConfig, loadSecrets, consumeSecrets, checkSignin, checkMail, smtpSecure, EMAIL, isEmail, ConfigError, strictInt, ROOT } // strictInt: exported for its max-required test;
