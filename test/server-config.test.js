'use strict';
// Server configuration: PORT parsing, BUILD fingerprint, extra static routes and MIME types.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const path = require('node:path');
const { ROOT } = require('./helpers/paths');
const { start, mkTmp, rmTmp, makeSrc } = require('./helpers/server');

const INDEX = path.join(ROOT, 'index.js');

test('PORT with surrounding whitespace is trimmed and 0 binds a free port', async () => {
  const dir = mkTmp('port-test-');
  const s = await start(INDEX, { PORT: ' 0 ', BIND_HOST: '127.0.0.1', DROP_DATA_DIR: dir });
  try {
    assert.strictEqual(s.exited, undefined, 'server exited: ' + s.out);
    assert.ok(s.port > 0 && s.port !== 3000, 'port was ' + s.port);
  } finally {
    await s.stop();
    rmTmp(dir);
  }
});

// Invalid PORT values must fall back to 3000. To avoid binding 3000 ourselves, we hold it
// once for the whole group: each child then dies with EADDRINUSE, which proves it tried 3000.
describe('invalid PORT falls back to 3000', { concurrency: true }, () => {
  let srv = null;
  before(async () => {
    const s = net.createServer();
    const held = await new Promise((resolve) => {
      s.once('error', () => resolve(false)); // someone else already holds it: same effect
      s.listen(3000, '127.0.0.1', () => resolve(true));
    });
    if (held) srv = s;
  });
  after(() => new Promise((r) => (srv ? srv.close(r) : r())));

  for (const bad of ['', '   ', '99999', '65536', 'abc', '8080abc', '-1', '1.5', '0x10']) {
    test(`PORT=${JSON.stringify(bad)} falls back to 3000`, async () => {
      const dir = mkTmp('port-test-');
      try {
        const s = await start(INDEX, { PORT: bad, BIND_HOST: '127.0.0.1', DROP_DATA_DIR: dir });
        await s.stop();
        assert.strictEqual(s.port, undefined, `bound port ${s.port} instead of 3000`);
        assert.ok(/EADDRINUSE/.test(s.out) && /3000/.test(s.out), 'expected EADDRINUSE on 3000, got:\n' + s.out);
      } finally {
        rmTmp(dir);
      }
    });
  }
});

// ---- BUILD fingerprint ignores docs/ ----
async function buildOf(dir) {
  const data = mkTmp('build-data-');
  const s = await start(path.join(dir, 'index.js'), { PORT: '0', BIND_HOST: '127.0.0.1', DROP_DATA_DIR: data });
  try {
    assert.strictEqual(s.exited, undefined, 'server exited: ' + s.out);
    return (await (await fetch(`http://127.0.0.1:${s.port}/health`)).json()).build;
  } finally {
    await s.stop();
    rmTmp(data);
  }
}

// Each variant is its own source copy, so the servers can run side by side.
async function buildsOf(variants) {
  const dirs = variants.map(makeSrc);
  try {
    return await Promise.all(dirs.map(buildOf));
  } finally {
    dirs.forEach(rmTmp);
  }
}

describe('BUILD fingerprint', { concurrency: true }, () => {
  test('includes a nested docs directory', async () => {
    const [a, b] = await buildsOf([{ 'web/docs/x': 'one' }, { 'web/docs/x': 'two, changed' }]);
    assert.notStrictEqual(b, a, 'web/docs change did not alter the build');
  });

  test('ignores docs/ but not other files', async () => {
    const [a, b, c] = await buildsOf([
      { 'docs/plan.md': 'one' },
      { 'docs/plan.md': 'two, changed', 'docs/new.md': 'added' },
      { 'docs/plan.md': 'two, changed', 'docs/new.md': 'added', 'extra.txt': 'x' },
    ]);
    assert.match(a, /^[0-9a-f]{12}$/);
    assert.strictEqual(b, a, 'docs/ change altered the build');
    assert.notStrictEqual(c, a, 'a non-docs file did not change the build');
  });
});
