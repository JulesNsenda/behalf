'use strict';
// Behalf: reference implementation of PXP v0 (Proxy Exchange Protocol).
// Zero dependencies. Node 18+.
const { createLog } = require('./lib/log');
const { createApp } = require('./lib/app');
const { StoreError } = require('./lib/store');

const log = createLog();
let app;
try { app = createApp({ log }); } catch (e) { log.error(e instanceof StoreError ? 'store.load_failed' : 'app.init_failed', {}, e); process.exit(1); }
const { config, proxy } = app;

const onListen = () => console.log(`Behalf (PXP/0) on :${app.server.address().port} · live=${proxy.live()} · model=${proxy.MODEL} · data=${config.dataDir} · mcp=${config.publicUrl}/mcp`);
app.listen(config.port, config.bindHost, onListen);

// A redeploy sends SIGTERM: write what is pending, then leave; a failed write exits non-zero. EventSource clients reconnect on their own.
process.on('SIGTERM', () => process.exit(app.shutdown() ? 0 : 1));
process.on('SIGINT', () => { app.shutdown(); process.exit(130); });
