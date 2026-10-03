'use strict';
// End to end for the store load call sites: a corrupt rooms.json is quarantined and logged once, with no file content.
// A store the server must not touch (unreadable, or from a newer version) stops it with a non-zero exit and is left as it was.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootServer, serverEnv } = require('../test-support/http');
const { start, mkTmp, rmTmp } = require('../test-support/server');
const { ROOT } = require('../test-support/paths');

const SECRET = 'SECRET-CARD-TEXT-9f3a';

test('a corrupt rooms.json is quarantined with one structured store.quarantined line, and the server starts empty', async () => {
  const bytes = '{"rooms": ' + SECRET + ' not json';
  const s = await bootServer('load-failed-', {}, (dir) => fs.writeFileSync(path.join(dir, 'rooms.json'), bytes));
  try {
    // On the platform (DROP_DATA_DIR set) with no DATABASE_URL the boot also warns that it fell back to the file store.
    assert.equal(s.out.split('\n').filter((l) => l.includes('store.file_fallback')).length, 1, s.out);
    const lines = s.out.split('\n').filter((l) => l.includes('store.') && !l.includes('store.file_fallback'));
    assert.equal(lines.length, 1, s.out);
    assert.match(lines[0], /^level=error event="store\.quarantined"/);
    assert.ok(!s.out.includes(SECRET), 'file content leaked into output');
    assert.ok(!/Unexpected token|is not valid JSON/.test(s.out), 'parser message leaked');
    const q = fs.readdirSync(s.dir).filter((n) => n.startsWith('rooms.json.corrupt-'));
    assert.equal(q.length, 1);
    assert.equal(fs.readFileSync(path.join(s.dir, q[0]), 'utf8'), bytes);
    const res = await fetch(s.base + '/health');
    assert.equal((await res.json()).rooms, 0);
  } finally {
    await s.stop();
  }
});

// A directory where the file should be: readFileSync fails with EISDIR on every OS.
const UNREADABLE = { name: 'an unreadable store', prepare: (file) => fs.mkdirSync(file), same: (file) => fs.statSync(file).isDirectory(), code: 'EISDIR' };
const FUTURE = { name: 'a store from a newer version', prepare: (file) => fs.writeFileSync(file, '{"schemaVersion":99,"rooms":{},"usage":{}}'), same: (file) => fs.readFileSync(file, 'utf8') === '{"schemaVersion":99,"rooms":{},"usage":{}}', code: 'EFUTURESCHEMA' };

for (const c of [UNREADABLE, FUTURE]) {
  test(c.name + ' stops the server with a non-zero exit and is left unchanged', async () => {
    const dir = mkTmp('load-refused-');
    try {
      const file = path.join(dir, 'rooms.json');
      c.prepare(file);
      const r = await start(path.join(ROOT, 'index.js'), serverEnv(dir));
      assert.ok(r.exited !== undefined && r.exited !== 0, 'expected a non-zero exit, got ' + JSON.stringify(r.exited) + '\n' + r.out);
      const lines = r.out.split('\n').filter((l) => l.includes('store.load_failed'));
      assert.equal(lines.length, 1, r.out);
      assert.ok(lines[0].includes('code="' + c.code + '"'), lines[0]);
      assert.ok(c.same(file), 'the store was changed');
      assert.deepEqual(fs.readdirSync(dir), ['rooms.json']);
      await r.stop();
    } finally {
      rmTmp(dir);
    }
  });
}
