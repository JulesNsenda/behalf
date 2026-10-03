'use strict';
// Shared by the tests that talk to a real Postgres. Lives outside test/, because `node --test` runs every .js file under it.
// PG_TEST_URL must name a scratch database (its name ends in _test): the tests drop tables and databases and terminate backends.
const assert = require('node:assert/strict');

const PG_URL = process.env.PG_TEST_URL;

// One pg client on `url`, connected for fn and always closed.
async function withClient(url, fn) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

// One query on a fresh connection to PG_TEST_URL, so a test can look at and change the database whatever state the stores are in.
const pgQuery = (sql, params) => withClient(PG_URL, (c) => c.query(sql, params));

// A second session for a test to hold locks with. Whatever the test does, it is rolled back and closed.
const withBlocker = (fn) => withClient(PG_URL, async (blocker) => {
  try { return await fn(blocker); } finally { await blocker.query('ROLLBACK').catch(() => {}); }
});

// Refuses to go on against a database that is not a scratch one. Checked once per process.
let scratchChecked = false;
async function assertScratch() {
  if (scratchChecked) return;
  const name = (await pgQuery('SELECT current_database() AS n')).rows[0].n;
  assert.ok(/_test$/.test(name), 'PG_TEST_URL must point at a database whose name ends in _test, got ' + name);
  scratchChecked = true;
}

const dropTable = async () => { await assertScratch(); await pgQuery('DROP TABLE IF EXISTS behalf_records'); };

// A statement for CREATE / DROP DATABASE (it cannot run in the scratch database itself): on PG_TEST_URL's server, scratch-checked.
async function pgAdmin(sql) {
  await assertScratch();
  await pgQuery(sql);
}

// A database of its own for one test file. The Postgres store takes an advisory lock per database and node --test runs files
// side by side, so two files must not share one. create() and drop() belong in the file's before() and after(); reset() gives
// each test an empty behalf_records. `name` is a plain identifier ending in _test.
function scratchDatabase(name) {
  assert.ok(/^[a-z][a-z0-9_]*_test$/.test(name), 'a scratch database name is a plain identifier ending in _test');
  const u = new URL(PG_URL);
  u.pathname = '/' + name;
  const url = u.toString();
  return {
    url,
    create: async () => { await pgAdmin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await pgAdmin(`CREATE DATABASE ${name}`); },
    drop: () => pgAdmin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
    reset: () => withClient(url, (c) => c.query('DROP TABLE IF EXISTS behalf_records')),
  };
}

module.exports = { PG_URL, withClient, pgQuery, withBlocker, assertScratch, dropTable, pgAdmin, scratchDatabase };
