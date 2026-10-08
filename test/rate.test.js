'use strict';
// lib/rate.js on its own: the fixed-window counter shared by sign-in (per address, per user) and the AI-access requests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRateTable } = require('../lib/rate');

function table(over = {}) {
  const clock = { t: 1000 };
  const hit = createRateTable({ now: () => clock.t, windowMs: 100, cap: 2, overflowCap: 3, maxKeys: 2, aggregate: () => 'agg', ...over });
  return { hit, clock };
}

test('a key is ok up to the cap, first over it once, then limited; keys are counted apart', () => {
  const { hit } = table();
  assert.deepEqual(['a', 'a', 'a', 'a', 'a'].map(hit), ['ok', 'ok', 'first', 'limited', 'limited']);
  assert.equal(hit('b'), 'ok', 'another key has its own count');
});

test('the window ends: a limited key is ok again, exactly at resetAt', () => {
  const { hit, clock } = table();
  for (let i = 0; i < 4; i++) hit('a');
  clock.t += 99;
  assert.equal(hit('a'), 'limited', 'still inside the window');
  clock.t += 1;
  assert.equal(hit('a'), 'ok', 'a new window');
  assert.equal(hit('a'), 'ok');
  assert.equal(hit('a'), 'first');
});

test('a full table of live windows counts a new key under its aggregate, with the overflow cap; known keys keep their own', () => {
  const { hit } = table();
  hit('a'); hit('b');
  assert.deepEqual(['c', 'd', 'e', 'f', 'g'].map(hit), ['ok', 'ok', 'ok', 'first', 'limited'], 'new keys share the aggregate bucket (cap 3)');
  assert.equal(hit('a'), 'ok', 'a known key still has its own slot');
  assert.equal(hit('a'), 'first');
});

test('a full table prunes ended windows before it overflows', () => {
  const { hit, clock } = table();
  hit('a'); hit('b');
  clock.t += 100;
  assert.deepEqual(['c', 'c', 'c'].map(hit), ['ok', 'ok', 'first'], 'c gets its own slot (cap 2), not the aggregate');
});

test('when the aggregate table is full too, the last resort is one shared overflow bucket', () => {
  let n = 0;
  const { hit } = table({ aggregate: () => 'agg' + n++ });
  hit('a'); hit('b'); // main full
  hit('c'); hit('d'); // over: agg0, agg1 (full)
  const rs = [];
  for (let i = 0; i < 4; i++) rs.push(hit('e' + i)); // all land in 'overflow'
  assert.deepEqual(rs, ['ok', 'ok', 'ok', 'first'], 'the shared bucket has the overflow cap (3)');
});
