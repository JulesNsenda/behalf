'use strict';
// The composition root: reads config and secrets once, builds the store and the domain, and assembles the `ops`
// object that lib/mcp.js uses. Every dependency can be overridden, so tests run it in-process with fakes:
// { config, secrets, log, store, proxy, demo, clock, file, fetch, timeouts, http }: fetch and timeouts go to the real
// proxy; http is merged into the options of createHttpServer (root, trustProxy, limits).
// createApp() never exits the process: a store that cannot load throws StoreError out of it.
// A store passed in `overrides.store` must already be loaded by the caller; createApp loads only a store it built (the file
// store). bootApp() is the async entry: it reads the config and secrets once, picks the store (Postgres when DATABASE_URL is
// set, else the file), awaits its load and then calls createApp. Extras for the Postgres store: overrides.storeOptions go to
// createPgStore and overrides.onFatal is its onFatal (the store was lost: the process should leave).
const path = require('path');
const { loadConfig, consumeSecrets } = require('./config');
const { createLog } = require('./log');
const { createStore } = require('./store');
const { createPgStore } = require('./store-pg'); // only requires pg inside load()
const { createProxy } = require('./proxy');
const { createRooms } = require('./rooms');
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

  // No passcode set: every guess matches.
  const passcodeMatches = (guess) => !secrets.passcode || safeEqual(guess, secrets.passcode);

  // The domain asks whether a live room can be opened: not once saving has been failing for a minute.
  const nowMs = (overrides.clock && overrides.clock.now) || (() => Date.now());
  const canCreateLiveRoom = () => {
    const { failingSince } = store.health();
    return failingSince === null || nowMs() - failingSince <= SAVE_FAILING_MS;
  };
  const domain = createRooms({ config, passcodeMatches, canCreateLiveRoom, store, proxy, demo, log, clock: overrides.clock });
  domain.hydrate();
  const sweepRooms = () => { domain.evictExpired(); domain.enforceCapacity(); };
  sweepRooms();
  // Hourly sweep. The interval is fixed: a TTL is only ever compared with timestamps, never passed to a timer.
  const sweep = setInterval(sweepRooms, 60 * 60 * 1000);
  sweep.unref();

  const view = (room, seatId, token) => viewRoom(room, seatId, token, { publicUrl: config.publicUrl, live: proxy.live() });

  // Shared operations, used by the web API and the MCP endpoint alike. Every member is synchronous except externalTurn.
  const ops = {
    rooms: domain.rooms, PUBLIC_URL: config.publicUrl, MAX_TURNS: config.maxTurns, ApiError: domain.ApiError, other: domain.other, view, seatLink: domain.seatLink,
    authSeat, createLiveRoom: domain.createLiveRoom, sealCard: domain.sealCard, joinAsAgent: domain.joinAsAgent,
    answerEscalation: domain.answerEscalation, externalTurn: domain.externalTurn, resume: domain.resume,
    live: () => proxy.live(), passcodeRequired: () => Boolean(secrets.passcode),
    log,
  };

  const trust = makeTrustProxy(config.trustProxy, { log }); // built once: it warns once about an ignored X-Forwarded-For
  const web = createHttpServer({
    domain, view, authSeat, log,
    mcpHandle: (req, res, deps) => mcp.handle(req, res, ops, deps),
    info: {
      live: () => proxy.live(), passcodeRequired: ops.passcodeRequired, maxTurns: config.maxTurns, publicUrl: config.publicUrl,
      storeKind: () => store.kind, storeOk: () => store.health().ok,
    },
    trustProxy: trust,
    ...overrides.http,
  });

  // Nothing listens until this is called. An unset or empty host binds all interfaces.
  function listen(port, host, cb) { return web.server.listen(port, host || undefined, cb); }

  // For tests: stop the turn loop, the web layer and the store's timer, without writing.
  function close() { clearInterval(sweep); domain.stop(); web.close(); store.close(); }

  // For the process to leave, any store: stop the turn loop and the web layer, then settle and close the store. Idempotent
  // (the second call returns the first's promise). Resolves to whether the final write succeeded. It never exits the process.
  let draining = null;
  function drain() {
    if (draining) return draining;
    draining = (async () => {
      let stopErr = null;
      try { clearInterval(sweep); domain.stop(); web.close(); } catch (e) { stopErr = e; }
      const ok = await store.drain();
      if (stopErr) throw stopErr;
      return ok;
    })();
    return draining;
  }

  return { config, log, store, domain, proxy, ops, view, server: web.server, diagnostics: web.diagnostics, listen, close, drain };
}

async function bootApp(overrides = {}) {
  const config = overrides.config || loadConfig();
  const secrets = overrides.secrets || consumeSecrets(); // read once, and removed from process.env
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
