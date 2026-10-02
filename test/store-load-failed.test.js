'use strict';
// End to end for the store.load_failed call site: a corrupt rooms.json is logged once, structured, with no file content.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootServer } = require('../test-support/http');

const SECRET = 'SECRET-CARD-TEXT-9f3a';

test('a corrupt rooms.json logs one structured store.load_failed line and starts empty', async () => {
  const s = await bootServer('load-failed-', {}, (dir) => fs.writeFileSync(path.join(dir, 'rooms.json'), '{"rooms": ' + SECRET + ' not json'));
  try {
    const lines = s.out.split('\n').filter((l) => l.includes('store.load_failed'));
    assert.equal(lines.length, 1, s.out);
    assert.match(lines[0], /^level=error event="store\.load_failed" errorClass="SyntaxError"/);
    assert.ok(!s.out.includes(SECRET), 'file content leaked into output');
    assert.ok(!/Unexpected token|is not valid JSON/.test(s.out), 'parser message leaked');
    const res = await fetch(s.base + '/health');
    assert.equal((await res.json()).rooms, 0);
  } finally {
    await s.stop();
  }
});
