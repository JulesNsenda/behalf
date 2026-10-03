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

// The one listen line index.js prints; the port is captured.
const LISTEN = /on :(\d+) /;

// Spawn node on `entry` (with node `args`, e.g. ['-r', preload]) in the allowlisted env plus `env`, tracked so a crashed test
// leaves no server behind. Returns { child, exited, listening, out(), stdout(), stop() }: exited resolves { code, signal, out,
// stdout } when the process is gone; listening resolves the port, or null if it exited without printing the listen line;
// stdout() is what went to stdout only (the listen line is its first line). A child that outlives killAfterMs is killed.
function spawnServer(entry, env, args = [], killAfterMs = 30000) {
  const child = spawn(process.execPath, [...args, entry], { env: baseEnv(env), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let out = '';
  let stdout = '';
  const exited = new Promise((resolve) => {
    const done = (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, stdout }); };
    const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.once('close', done);
    child.once('error', () => done(null, null));
  });
  const listening = new Promise((resolve) => {
    child.stdout.on('data', (d) => { out += d; stdout += d; const m = LISTEN.exec(stdout); if (m) resolve(Number(m[1])); });
    child.stderr.on('data', (d) => { out += d; });
    exited.then(() => resolve(null));
  });
  const stop = async () => { if (child.exitCode === null) child.kill(); await exited; };
  return { child, exited, listening, out: () => out, stdout: () => stdout, stop };
}

// Spawn a server; resolve with {port, out, stop} once it prints its port, or {exited, out, stop} if it dies first.
function start(entry, env, args = []) {
  const s = spawnServer(entry, env, args, 10000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.child.kill(); reject(new Error('no start/exit within 10s. Output:\n' + s.out())); }, 10000);
    s.listening.then((port) => {
      clearTimeout(timer);
      if (port !== null) return resolve({ port, out: s.out(), stop: s.stop });
      return s.exited.then((r) => resolve({ exited: r.code, out: r.out, stop: async () => {} }));
    });
  });
}

// index.js on a free loopback port with `dir` as its data dir.
const spawnIndex = (dir, env = {}, args = [], killAfterMs) => spawnServer(path.join(ROOT, 'index.js'), { PORT: '0', BIND_HOST: '127.0.0.1', DROP_DATA_DIR: dir, ...env }, args, killAfterMs);

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

module.exports = { baseEnv, start, spawnServer, spawnIndex, mkTmp, rmTmp, makeSrc, postJson, getView };
