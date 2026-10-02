'use strict';
// Shared by the tests that spawn index.js. Lives outside test/, because `node --test` runs every .js file under it.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT } = require('./paths');

// Allowlist, so a developer's own PORT, API key or passcode can't change the run.
function baseEnv(extra) {
  const env = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return Object.assign(env, extra);
}

// If a test crashes early, don't leave a server running.
const children = new Set();
const killAll = () => { for (const c of children) { try { if (c.exitCode === null) c.kill(); } catch (e) { /* gone */ } } };
process.on('exit', killAll);
// A Ctrl-C or a kill would otherwise skip the exit handler and orphan the servers.
process.on('SIGINT', () => { killAll(); process.exit(130); });
process.on('SIGTERM', () => { killAll(); process.exit(143); });

// Spawn a server; resolve with {port, out, stop} once it prints its port, or {exited, out, stop} if it dies first.
function start(entry, env) {
  const child = spawn(process.execPath, [entry], { env: baseEnv(env), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let out = '';
  const closed = new Promise((r) => { child.once('close', r); child.once('error', r); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('no start/exit within 10s. Output:\n' + out)); }, 10000);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    child.stderr.on('data', (d) => { out += d; });
    child.stdout.on('data', (d) => {
      out += d;
      const m = /on :(\d+) /.exec(out);
      if (m) done({ port: Number(m[1]), out, stop: async () => { if (child.exitCode === null) child.kill(); await closed; } });
    });
    child.once('close', (code) => done({ exited: code, out, stop: async () => {} }));
  });
}

const mkTmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// Windows holds file handles briefly after a child exits, hence the retries.
const rmTmp = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

// A temp copy of index.js and lib/ to run the BUILD fingerprint against. `extra` maps relative path -> content.
function makeSrc(extra = {}) {
  const dir = mkTmp('build-src-');
  fs.copyFileSync(path.join(ROOT, 'index.js'), path.join(dir, 'index.js'));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  for (const [rel, content] of Object.entries(extra)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

// POST a JSON body to a running server: resolves {status, json}. headers adds to the defaults (the /mcp
// endpoint wants an accept header).
async function postJson(base, p, body, headers) {
  const res = await fetch(base + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body || {}) });
  return { status: res.status, json: await res.json() };
}

// One room's view as a seat (or as a spectator, with no seat): resolves {status, R}, R null unless it was a 200.
async function getView(base, id, seat, token) {
  const q = seat ? `?seat=${seat}&t=${encodeURIComponent(token)}` : '';
  const res = await fetch(`${base}/api/rooms/${id}${q}`);
  return { status: res.status, R: res.status === 200 ? await res.json() : null };
}

module.exports = { baseEnv, start, mkTmp, rmTmp, makeSrc, postJson, getView };
