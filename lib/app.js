'use strict';
// The composition root: reads config and secrets once, builds the store and the domain, and assembles the `ops`
// object that lib/mcp.js uses. Every dependency can be overridden, so tests run it in-process with fakes:
// { config, secrets, log, store, proxy, demo, clock, file, fetch, timeouts, http }: fetch and timeouts go to the real
// proxy; http is merged into the options of createHttpServer (root, trustProxy, limits).
// createApp() never exits the process: a store that cannot load throws StoreError out of it.
// A store passed in `overrides.store` must already be loaded by the caller; createApp loads only a store it built.
const path = require('path');
const { loadConfig, loadSecrets } = require('./config');
const { createLog } = require('./log');
const { createStore } = require('./store');
const { createProxy } = require('./proxy');
const { createRooms } = require('./rooms');
const { view: viewRoom, authSeat, safeEqual } = require('./view');
const { createHttpServer } = require('./http');
const mcp = require('./mcp');
const { makeTrustProxy } = require('./net');

function createApp(overrides = {}) {
  const config = overrides.config || loadConfig();
  let secrets = overrides.secrets;
  if (!secrets) {
    secrets = loadSecrets();
    // The passcode and the API key are only read through secrets from here on. Defence in depth only: this clears
    // process.env, not the kernel's copy of the environment block (/proc/<pid>/environ).
    delete process.env.ROOM_PASSCODE;
    delete process.env.ANTHROPIC_API_KEY;
  }
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
    store = createStore({ file: overrides.file || path.join(config.dataDir, 'rooms.json'), log });
    store.load();
  }

  // No passcode set: every guess matches.
  const passcodeMatches = (guess) => !secrets.passcode || safeEqual(guess, secrets.passcode);

  const domain = createRooms({ config, passcodeMatches, store, proxy, demo, log, clock: overrides.clock });
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
    info: { live: () => proxy.live(), passcodeRequired: ops.passcodeRequired, maxTurns: config.maxTurns, publicUrl: config.publicUrl },
    trustProxy: trust,
    ...overrides.http,
  });

  // Nothing listens until this is called. An unset or empty host binds all interfaces.
  function listen(port, host, cb) { return web.server.listen(port, host || undefined, cb); }

  // For tests: stop the turn loop, the web layer and the store's timer, without writing.
  function close() { clearInterval(sweep); domain.stop(); web.close(); store.close(); }

  // For the process to leave: stop the turn loop, end the streams, write the store to disk. Synchronous and
  // idempotent. Returns whether the final write succeeded. It never exits the process.
  let outcome;
  function shutdown() {
    if (outcome !== undefined) return outcome;
    try { clearInterval(sweep); domain.stop(); web.close(); } finally { outcome = store.flush(); store.close(); }
    return outcome;
  }

  return { config, log, store, domain, proxy, ops, view, server: web.server, diagnostics: web.diagnostics, listen, close, shutdown };
}

module.exports = { createApp };
