'use strict';
// For `node -r`: makes app.drain() of the app bootApp builds never settle, so a test can see the deadlines in index.js
// (the drain deadline on a signal, the 2 s bound on a crash) cut it off.
const appLib = require('../lib/app');
const real = appLib.bootApp;
appLib.bootApp = async (...args) => {
  const app = await real(...args);
  app.drain = () => new Promise(() => {});
  return app;
};
