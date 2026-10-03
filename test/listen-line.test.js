'use strict';
// The listen line is a console.log on stdout that test-support/server.js and the deploy tooling match on. Pin its shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootServer } = require('../test-support/http');

test('the listen line keeps its exact shape', async () => {
  const s = await bootServer('listen-line-', {});
  try {
    assert.match(s.out, /^Behalf \(PXP\/0\) on :\d+ · live=(true|false) · model=\S+ · data=.+ · mcp=\S+\/mcp$/m);
  } finally {
    await s.stop();
  }
});
