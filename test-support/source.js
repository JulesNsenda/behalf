'use strict';
const assert = require('node:assert');
const fs = require('node:fs');

// A source file without its header comment and without whole-line // comments, so the checks
// below look at code and strings only.
function codeOf(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//, '');
  return src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

// The checks every pure view module must pass: no DOM, UI, markup, storage or regex constructor.
// allowRequire is for the one module that reads another (agreement-view reads room-view).
function assertPure(code, { allowRequire = false } = {}) {
  assert.ok(!/\bdocument\b|\bUI\b|innerHTML|localStorage|sessionStorage|\bfetch\b|\blocation\b/.test(code));
  if (!allowRequire) assert.ok(!/require\(/.test(code), 'no require');
  assert.ok(!/<\/?[a-z][a-z0-9]*[\s>]/i.test(code.replace(/<script>alert/g, '')), 'no markup in strings');
  assert.ok(!/new RegExp|RegExp\(/.test(code), 'regex literals only');
}

module.exports = { codeOf, assertPure };
