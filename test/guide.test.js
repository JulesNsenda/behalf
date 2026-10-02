'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { UI_DIR } = require('../test-support/paths');

const GUIDE_SRC = fs.readFileSync(path.join(UI_DIR, 'guide.js'), 'utf8');

// Runs guide.js (or a modified copy of its source) against a minimal DOM stub.
function run(src) {
  const props = { '--bg': '#fff', '--accent': 'rgb(1, 2, 3)', '--radius': '8px', '--focus': 'var(--accent)' };
  const names = Object.keys(props);
  const style = { length: names.length, getPropertyValue: (n) => props[n] };
  names.forEach((n, i) => { style[i] = n; });
  const sheet = {
    href: 'http://x/ui/ui.css',
    cssRules: [{ cssRules: [{ selectorText: ':root', style }] }], // layer-like wrapper
  };
  const otherSheet = { href: 'http://x/ui/guide.css', cssRules: [] };

  const elem = () => ({
    className: '', textContent: '', style: {}, children: [],
    appendChild(c) { this.children.push(c); return c; },
  });
  const grid = elem();
  const code = elem();
  const example = { getAttribute: () => 'btn', innerHTML: '\n    <button class="btn">\n      Go\n    </button>\n  ' };
  const selectors = [];

  const document = {
    readyState: 'complete',
    styleSheets: [otherSheet, sheet],
    addEventListener() {},
    createElement: elem,
    createDocumentFragment: elem,
    getElementById: () => null,
    querySelector(sel) {
      selectors.push(sel);
      if (sel === '[data-swatches]') return grid;
      if (sel === '[data-snippet-for="btn"]') return code;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-snippet]') return [example];
      return [];
    },
  };
  const ctx = {
    document,
    CSS: {
      supports: (prop, v) => /^(#|rgb|var\()/.test(v), // browsers accept var() at parse time
      escape: (s) => s,
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(src, ctx);
  return { grid, code };
}

test('guide.js emits one swatch per colour token and skips non-colour tokens', () => {
  const { grid } = run(GUIDE_SRC);
  assert.strictEqual(grid.children.length, 1, 'fragment appended to grid');
  const labels = grid.children[0].children.map((card) => card.children[1].textContent);
  assert.deepStrictEqual(labels, ['--bg', '--accent', '--focus']);
  assert.strictEqual(grid.children[0].children[0].children[0].style.background, 'var(--bg)');
  assert.strictEqual(grid.children[0].children[2].children[0].style.background, 'var(--focus)', 'an aliased token gets a swatch');
});

test('guide.js writes dedented example markup into the matching snippet holder', () => {
  const { code } = run(GUIDE_SRC);
  assert.strictEqual(code.textContent, '<button class="btn">\n  Go\n</button>');
});
