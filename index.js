'use strict';
// Behalf: reference implementation of PXP v0 (Proxy Exchange Protocol).
// Node 18+. The only dependency is pg, loaded only when DATABASE_URL is set.
const { createLog } = require('./lib/log');
const { bootApp } = require('./lib/app');
const { loadConfig } = require('./lib/config');
const http = require('node:http');
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

// Drop starts a redeploy's new instance while the old one still serves, and stops the old one only once the new one answers HTTP
// (any status). A Postgres boot waits for the old instance's lock, so until bootApp resolves this placeholder holds the port and
// answers 503 "starting". It prints nothing: the listen line stays the first stdout line, and is printed by the real server.
const STARTING = JSON.stringify({ error: 'Behalf is starting. Try again in a moment.', code: 'starting' });
const STARTING_HEALTH = JSON.stringify({ ok: false, starting: true });
function startPlaceholder(port, host) {
  const server = http.createServer((req, res) => {
    const body = req.url === '/health' || req.url.startsWith('/health?') ? STARTING_HEALTH : STARTING;
    res.writeHead(503, {
      'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'retry-after': '5', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', connection: 'close',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}
// Frees the port: every socket is closed (the placeholder never keeps one alive), then the real server binds it.
const closePlaceholder = (server) => new Promise((resolve) => {
  server.close(() => resolve());
  if (server.closeAllConnections) server.closeAllConnections();
});

// A listen failure is not an unhandled error: say which port, and the error code only.
function listenFailed(config, e) {
  log.error('app.listen_failed', {}, e);
  const code = safeCode(e);
  console.error(`Behalf could not listen on port ${config.port}${code ? ' (' + code + ')' : ''}`);
  process.exit(1);
}

async function main() {
  let config;
  let placeholder = null;
  // While booting there is nothing to drain: a SIGTERM (the platform gave up on this instance) or SIGINT leaves at once, 0 and 130
  // like the drained exits below. The store may hold a connection; the process leaving releases it and the lock with it.
  const onSignal = (okCode) => () => {
    if (app) return exitAfterDrain(config.drainDeadlineMs, okCode, okCode === 0 ? 1 : okCode);
    if (leaving) return;
    leaving = true;
    process.exit(okCode);
  };
  process.on('SIGTERM', onSignal(0));
  process.on('SIGINT', onSignal(130));
  try {
    config = loadConfig();
    try { placeholder = await startPlaceholder(config.port, config.bindHost); } catch (e) { return listenFailed(config, e); }
    const port = placeholder.address().port; // PORT=0: the real server takes the placeholder's port, not another
    // onFatal: the store was lost (its connection or lock). It has closed itself and can no longer write, so leave and let the
    // platform restart the process, which reloads from the database.
    app = await bootApp({ config: { ...config, port }, log, onFatal: () => exitAfterDrain(crashBoundMs(), 1, 1) });
  } catch (e) {
    if (placeholder) await closePlaceholder(placeholder);
    log.error(e instanceof StoreError ? 'store.load_failed' : 'app.init_failed', {}, e); process.exit(1);
  }
  await closePlaceholder(placeholder);
  const { proxy } = app;
  config = app.config;


  const onListen = () => {
    app.server.off('error', onListenError);
    app.server.on('error', (e) => log.error('app.server_error', {}, e)); // a later error is not a reason to leave
    console.log(`Behalf (PXP/0) on :${app.server.address().port} · live=${proxy.live()} · model=${proxy.MODEL} · data=${config.dataDir} · mcp=${config.publicUrl}/mcp`);
  };
  const onListenError = (e) => listenFailed(config, e);
  app.server.on('error', onListenError);
  app.listen(config.port, config.bindHost, onListen);

  // A redeploy sends SIGTERM: onSignal (above) writes what is pending, then leaves; a failed write exits non-zero (SIGINT always
  // 130). EventSource clients reconnect on their own.
}

main();
