'use strict';
// For `node -r`: bootApp waits BOOT_DELAY_MS before it starts (a stand-in for waiting on the old instance's lock), and with
// BOOT_FAIL=1 then fails with a StoreError, so the placeholder phase of index.js can be tested without a database.
const app = require('../lib/app');
const { StoreError } = require('../lib/store-core');
const real = app.bootApp;
app.bootApp = async (o) => {
  await new Promise((r) => setTimeout(r, Number(process.env.BOOT_DELAY_MS || 0)));
  if (process.env.BOOT_FAIL === '1') throw new StoreError('STORE_TEST', 'boom');
  return real(o);
};
