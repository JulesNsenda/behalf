'use strict';
// The composition root: reads config and secrets once, builds the store and the domain, and assembles the `ops`
// object that lib/mcp.js uses. Every dependency can be overridden, so tests run it in-process with fakes:
// { config, secrets, log, store, proxy, mailer, demo, clock, file, fetch, timeouts, http }: fetch and timeouts go to the real
// proxy; githubFetch (else fetch) is the one GitHub sign-in calls; http is merged into the options of createHttpServer (root, trustProxy, limits).
// The returned `auth` and `aiAccess` (null with sign-in off) are for tests only: nothing in the server reads them from the result.
// createApp() never exits the process: a store that cannot load throws StoreError out of it.
// A store passed in `overrides.store` must already be loaded by the caller; createApp loads only a store it built (the file
// store). bootApp() is the async entry: it reads the config and secrets once, picks the store (Postgres when DATABASE_URL is
// set, else the file), awaits its load and then calls createApp. Extras for the Postgres store: overrides.storeOptions go to
// createPgStore and overrides.onFatal is its onFatal (the store was lost: the process should leave).
const path = require('path');
const { loadConfig, consumeSecrets, checkSignin, checkMail } = require('./config');
const { createLog } = require('./log');
const { createStore } = require('./store');
const { createPgStore } = require('./store-pg'); // only requires pg inside load()
const { createProxy } = require('./proxy');
const { createRooms } = require('./rooms');
const { createAuth } = require('./auth');
const { createAiAccess } = require('./ai-access');
const { createMailer } = require('./mail'); // nodemailer is loaded only when MAIL_TRANSPORT=smtp
const { view: viewRoom, authSeat, safeEqual } = require('./view');
const { createHttpServer } = require('./http');
const mcp = require('./mcp');
const { makeTrustProxy } = require('./net');

const SAVE_FAILING_MS = 60000; // writes failing for this long: no new live room (it could not be kept)

// The store for a config: Postgres when there is a database url, else the file. Not loaded. The file (and the one a Postgres
// store imports from) is rooms.json in the data dir unless overrides.file says otherwise.
function buildStore({ config, secrets, overrides, log }) {
  const file = overrides.file || path.join(config.dataDir, 'rooms.json');
  if (secrets.databaseUrl) {
    return createPgStore({ url: secrets.databaseUrl, log, importFile: file, clock: overrides.clock, ...overrides.storeOptions, onFatal: overrides.onFatal });
  }
  if (process.env.DROP_DATA_DIR) log.warn('store.file_fallback', {}); // the platform gave a data dir but no database: rooms would live on that disk only
  return createStore({ file, log, clock: overrides.clock });
}

function createApp(overrides = {}) {
  const config = overrides.config || loadConfig();
  let secrets = overrides.secrets;
  // The secrets are only read through the secrets object from here on: consumeSecrets also removes them from process.env.
  if (!secrets) secrets = consumeSecrets();
  // bootApp owns the choice of store: a database url with no store handed in would silently fall back to the file.
  if (secrets.databaseUrl && !overrides.store) throw new Error('DATABASE_URL is set: build the app with bootApp()');
  checkSignin(config, secrets); // BAD_SIGNIN_SECRETS / BAD_PUBLIC_URL: the one place the sign-in settings are checked
  checkMail(config, secrets); // BAD_SMTP_* / BAD_MAIL_FROM: the one place the mail settings are checked
  const signinOn = config.signin === 'github'; // the one flag: the domain, the web layer and ops are all told it, none re-derives it
  const log = overrides.log || createLog();
  const proxy = overrides.proxy || createProxy({
    apiKey: secrets.apiKey,
    model: config.model,
    fetch: overrides.fetch,
    clock: overrides.clock,
    timeouts: overrides.timeouts,
    log,
    beforeCall: (room, kind) => domain.chargeCall(room, kind), // must stay an arrow: domain is created below
  });
  const demo = overrides.demo || require('./demo');
  let store = overrides.store;
  if (!store) {
    store = buildStore({ config, secrets, overrides, log });
    store.load();
  }

  // Email. The transport is checked once, in the background: a failure turns sending off and leaves the rest of the app running.
  const mailer = overrides.mailer || createMailer({ config, secrets, log, clock: overrides.clock });
  mailer.start();

  // The room passcode, decided once: only a server with sign-in off asks for it (a signed-in person, or a valid agent key, is who is
  // asking). /api/config, ops.passcodeRequired and the domain's check all follow from these two. No passcode set: every guess matches.
  const passcodeRequired = () => Boolean(secrets.passcode) && !signinOn;
  const passcodeMatches = (guess) => !passcodeRequired() || safeEqual(guess, secrets.passcode);

  // What a failing store allows: a live room can still be opened for a minute (it will most likely be kept); a revocation (logout,
  // revoke, mint) is not attempted at all, because one that cannot be saved must not look done. The domain and auth ask; they never
  // read the store's health themselves.
  const nowMs = (overrides.clock && overrides.clock.now) || (() => Date.now());
  const savePolicy = {
    canCreate: () => { const { failingSince } = store.health(); return failingSince === null || nowMs() - failingSince <= SAVE_FAILING_MS; },
    canRevoke: () => store.health().failingSince === null,
  };
  // Sign-in: the accounts live in the store's user, session and agentkey collections, and "Use our AI" access in aiaccess
  // (lib/ai-access.js). Both are built before the domain, which asks aiAccess. Absent with sign-in off.
  const auth = signinOn ? createAuth({ store, config, secrets, canRevoke: savePolicy.canRevoke, fetch: overrides.githubFetch || overrides.fetch, clock: { now: nowMs }, log }) : null;
  const aiAccess = auth ? createAiAccess({ store, config, canRevoke: savePolicy.canRevoke, userInfo: auth.userInfo, clock: { now: nowMs }, log }) : null;
  const domain = createRooms({
    config, signinOn, passcodeRequired, passcodeMatches, canCreateLiveRoom: savePolicy.canCreate, store, proxy, demo, log, clock: overrides.clock,
    canUseAi: aiAccess ? aiAccess.canUseAi : () => false, isAdmin: aiAccess ? aiAccess.isAdmin : () => false,
  });
  domain.hydrate();
  // A passcode with sign-in on is never asked for: say so, but keep running.
  if (signinOn && secrets.passcode) log.warn('app.passcode_ignored', {});
  // Without an admin nobody can approve a request and the built-in AI is closed to everyone else: say so, but keep running.
  if (signinOn && proxy.live() && config.adminGithubIds.length === 0) log.warn('app.no_admins', {});
  // The housekeeping pass: expired rooms, room capacity, expired sessions. Each part on its own, so one that throws does not stop the rest.
  const sweep = () => {
    for (const part of [() => domain.evictExpired(), () => domain.enforceCapacity(), () => auth && auth.sweep()]) {
      try { part(); } catch (e) { log.error('app.sweep_failed', {}, e); }
    }
  };
  sweep();
  // Hourly sweep. The interval is fixed: a TTL is only ever compared with timestamps, never passed to a timer.
  const sweepTimer = setInterval(sweep, 60 * 60 * 1000);
  sweepTimer.unref();

  // live is per room: a room whose opener had no "Use our AI" access (room.ai === false) has no built-in AI to offer.
  const view = (room, seatId, token) => viewRoom(room, seatId, token, { publicUrl: config.publicUrl, live: proxy.live() && room.ai !== false });

  // Shared operations, used by the web API and the MCP endpoint alike. Every member is synchronous except externalTurn.
  const ops = {
    rooms: domain.rooms, PUBLIC_URL: config.publicUrl, MAX_TURNS: config.maxTurns, ApiError: domain.ApiError, other: domain.other, view, seatLink: domain.seatLink,
    authSeat, createLiveRoom: domain.createLiveRoom, sealCard: domain.sealCard, joinAsAgent: domain.joinAsAgent,
    answerEscalation: domain.answerEscalation, externalTurn: domain.externalTurn, resume: domain.resume,
    live: () => proxy.live(), passcodeRequired,
    signinOn, userForAgentKey: (key) => (auth ? auth.userForAgentKey(key) : null), // the key's user, or null (sign-in off, unknown, blocked, idle)
    log,
  };

  const trust = makeTrustProxy(config.trustProxy, { log }); // built once: it warns once about an ignored X-Forwarded-For
  const web = createHttpServer({
    domain, view, authSeat, log,
    mcpHandle: (req, res, deps) => mcp.handle(req, res, ops, deps),
    info: {
      live: () => proxy.live(), passcodeRequired: ops.passcodeRequired, maxTurns: config.maxTurns, publicUrl: config.publicUrl, signin: config.signin, signinOn,
      storeKind: () => store.kind, storeOk: () => store.health().ok,
      mailKind: mailer.kind, mailOk: () => mailer.status() === 'ready',
    },
    // The dev outbox page, only off the platform (config.devOutbox) and only with the dev transport.
    outbox: config.devOutbox ? mailer.outbox : null,
    trustProxy: trust,
    auth,
    aiAccess,
    ...overrides.http,
  });

  // Nothing listens until this is called. An unset or empty host binds all interfaces.
  function listen(port, host, cb) { return web.server.listen(port, host || undefined, cb); }

  // For tests: stop the turn loop, the web layer and the store's timer, without writing.
  function close() { clearInterval(sweepTimer); domain.stop(); web.close(); mailer.close(); store.close(); }

  // For the process to leave, any store: stop the turn loop and the web layer, then settle and close the store. Idempotent
  // (the second call returns the first's promise). Resolves to whether the final write succeeded. It never exits the process.
  let draining = null;
  function drain() {
    if (draining) return draining;
    draining = (async () => {
      let stopErr = null;
      try { clearInterval(sweepTimer); domain.stop(); web.close(); mailer.close(); } catch (e) { stopErr = e; }
      const ok = await store.drain();
      if (stopErr) throw stopErr;
      return ok;
    })();
    return draining;
  }

  return { config, log, store, domain, proxy, auth, aiAccess, mailer, ops, view, server: web.server, diagnostics: web.diagnostics, listen, close, drain };
}

async function bootApp(overrides = {}) {
  const config = overrides.config || loadConfig();
  const secrets = overrides.secrets || consumeSecrets(); // read once, and removed from process.env
  checkSignin(config, secrets); // for ordering only (a bad setting must stop the boot before the store is opened); createApp is the check
  checkMail(config, secrets); // the same
  const log = overrides.log || createLog();
  let store = overrides.store;
  let built = false;
  if (!store) {
    store = buildStore({ config, secrets, overrides, log });
    await store.load();
    built = true;
  }
  try {
    return createApp({ ...overrides, config, secrets, log, store });
  } catch (e) {
    if (built) await store.close(); // never leave the lock and the connection behind
    throw e;
  }
}

module.exports = { createApp, bootApp };
