'use strict';
// Behalf: reference implementation of PXP v0 (Proxy Exchange Protocol).
// Node 18+. The only dependency is pg, loaded only when DATABASE_URL is set.
const { createLog } = require('./lib/log');
const { bootApp } = require('./lib/app');
const { StoreError, safeCode } = require('./lib/store-core');

const log = createLog();
let app = null;
let leaving = false;
// A crash (or a lost store) tries to write what is pending for at most 2 s, and never past the drain deadline.
const crashBoundMs = () => (app ? Math.min(2000, app.config.drainDeadlineMs) : 0);

// The one way out. The first reason wins; later ones are ignored. Drains the app for at most `ms` and then exits: okCode if the
// drain succeeded, failCode if it failed, threw or timed out (a timeout is logged). Without an app there is nothing to drain.
function exitAfterDrain(ms, okCode, failCode) {
  if (leaving) return;
  leaving = true;
  if (!app) process.exit(failCode);
  // The timer stays referenced: a drain that hangs cannot let the process leave with a clean 0.
  setTimeout(() => { log.error('app.drain_timeout', {}); process.exit(failCode); }, ms);
  Promise.resolve().then(() => app.drain()).then((ok) => ok, () => false).then((ok) => process.exit(ok ? okCode : failCode));
}

// An error is only ever written through the safe logger: a DATABASE_URL parse error would echo the password.
const crash = (event) => (err) => {
  log.error(event, {}, err);
  exitAfterDrain(crashBoundMs(), 1, 1);
};
process.on('unhandledRejection', crash('app.unhandled_rejection'));
process.on('uncaughtException', crash('app.uncaught_exception'));

async function main() {
  try {
    // onFatal: the store was lost (its connection or lock). It has closed itself and can no longer write, so leave and let the
    // platform restart the process, which reloads from the database.
    app = await bootApp({ log, onFatal: () => exitAfterDrain(crashBoundMs(), 1, 1) });
  } catch (e) { log.error(e instanceof StoreError ? 'store.load_failed' : 'app.init_failed', {}, e); process.exit(1); }
  const { config, proxy } = app;

  const onListen = () => {
    app.server.off('error', onListenError);
    app.server.on('error', (e) => log.error('app.server_error', {}, e)); // a later error is not a reason to leave
    console.log(`Behalf (PXP/0) on :${app.server.address().port} · live=${proxy.live()} · model=${proxy.MODEL} · data=${config.dataDir} · mcp=${config.publicUrl}/mcp`);
  };
  // A listen failure is not an unhandled error: say which port, and the error code only.
  const onListenError = (e) => {
    log.error('app.listen_failed', {}, e);
    const code = safeCode(e);
    console.error(`Behalf could not listen on port ${config.port}${code ? ' (' + code + ')' : ''}`);
    process.exit(1);
  };
  app.server.on('error', onListenError);
  app.listen(config.port, config.bindHost, onListen);

  // A redeploy sends SIGTERM: write what is pending, then leave; a failed write exits non-zero (SIGINT always 130). EventSource
  // clients reconnect on their own.
  process.on('SIGTERM', () => exitAfterDrain(config.drainDeadlineMs, 0, 1));
  process.on('SIGINT', () => exitAfterDrain(config.drainDeadlineMs, 130, 130));
}

main();
