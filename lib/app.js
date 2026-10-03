'use strict';
// The composition root: reads config and secrets once, builds the store and the domain, and assembles the `ops`
// object that lib/mcp.js uses. Every dependency can be overridden, so tests run it in-process with fakes:
// { config, secrets, log, store, proxy, demo, clock, file }.
// createApp() never exits the process: a store that cannot load throws StoreError out of it.
// A store passed in `overrides.store` must already be loaded by the caller; createApp loads only a store it built.
const path = require('path');
const { loadConfig, loadSecrets } = require('./config');
const { createLog } = require('./log');
const { createStore } = require('./store');
const { createRooms } = require('./rooms');
const { view: viewRoom, authSeat, safeEqual } = require('./view');

function createApp(overrides = {}) {
  const config = overrides.config || loadConfig();
  let secrets = overrides.secrets;
  if (!secrets) {
    secrets = loadSecrets();
    // The passcode is only read through secrets from here on. ANTHROPIC_API_KEY stays in the environment until
    // item 8 (createProxy), because lib/proxy.js still reads it at require time.
    delete process.env.ROOM_PASSCODE;
  }
  const log = overrides.log || createLog();
  const proxy = overrides.proxy || require('./proxy');
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

  const view = (room, seatId, token) => viewRoom(room, seatId, token, { publicUrl: config.publicUrl, live: proxy.live() });

  // Shared operations, used by the web API and the MCP endpoint alike. Every member is synchronous except externalTurn.
  const ops = {
    rooms: domain.rooms, PUBLIC_URL: config.publicUrl, MAX_TURNS: config.maxTurns, ApiError: domain.ApiError, other: domain.other, view, seatLink: domain.seatLink,
    authSeat, createLiveRoom: domain.createLiveRoom, sealCard: domain.sealCard, joinAsAgent: domain.joinAsAgent,
    answerEscalation: domain.answerEscalation, externalTurn: domain.externalTurn, resume: domain.resume,
    live: () => proxy.live(), passcodeRequired: () => Boolean(secrets.passcode),
    log,
  };

  // For tests and shutdown: stop the turn loop, then stop the store's timer.
  function close() { domain.stop(); store.close(); }

  return { config, log, store, domain, proxy, ops, view, close };
}

module.exports = { createApp };
