'use strict';
// Shared by the tests that drive a spawned server over HTTP. Lives outside test/, because `node --test` runs every .js file under it.
const assert = require('node:assert');
const path = require('node:path');
const { ROOT } = require('./paths');
const { start, mkTmp, rmTmp } = require('./server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn index.js on a fresh data dir. `prepare(dir)` runs first (e.g. to drop a rooms.json in). stop() also removes the dir.
async function bootServer(prefix, env, prepare) {
  const dir = mkTmp(prefix);
  try {
    if (prepare) prepare(dir);
    const server = await start(path.join(ROOT, 'index.js'), Object.assign({ PORT: '0', BIND_HOST: '127.0.0.1', DROP_DATA_DIR: dir }, env));
    assert.strictEqual(server.exited, undefined, 'server exited early with code ' + server.exited + '. Output:\n' + server.out);
    return {
      base: `http://127.0.0.1:${server.port}`, port: server.port, dir,
      stop: async () => { try { await server.stop(); } finally { rmTmp(dir); } },
    };
  } catch (e) { rmTmp(dir); throw e; }
}

// One behaviour for every body: json is the parsed body, or null when it isn't JSON.
function client(base) {
  async function getJson(url, init) {
    const res = await fetch(base + url, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json, text };
  }
  const post = (url, body) => getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { getJson, post };
}

// Poll fn() until pred(value) holds; throws, with the last value, when it never does.
async function waitFor(fn, pred, { timeoutMs = 5000, intervalMs = 50, what = 'the condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() >= end) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; last value: ${JSON.stringify(v).slice(0, 300)}`);
    await sleep(intervalMs);
  }
}

// None of `secrets` (falsy ones are ignored) may appear in `text`.
function assertNoSecrets(text, secrets, where) {
  for (const s of secrets) if (s) assert.ok(!text.includes(s), `${where}: leaked ${s}`);
}

module.exports = { bootServer, client, waitFor, assertNoSecrets, sleep };
