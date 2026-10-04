'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { UI_CSS } = require('../test-support/paths');
const { stripComments, parseBlocks } = require('../test-support/css');

const css = fs.readFileSync(UI_CSS, 'utf8');
const pairs = JSON.parse(fs.readFileSync(path.join(__dirname, 'contrast-pairs.json'), 'utf8'));

const clean = stripComments(css);
const tree = parseBlocks(clean, 0, clean.length);

function walk(nodes, fn, parents = []) {
  for (const n of nodes) { fn(n, parents); walk(n.children, fn, parents.concat(n)); }
}
function find(pred) {
  const out = [];
  walk(tree, (n, parents) => { if (pred(n, parents)) out.push({ node: n, parents }); });
  return out;
}
// Declaration text of a block: its body with nested blocks (and their preludes) cut out.
function ownBody(n) {
  let out = '';
  let pos = n.open;
  for (const c of n.children) {
    out += clean.slice(pos, c.pstart);
    pos = c.close + 1;
  }
  return out + clean.slice(pos, n.close);
}
const norm = (s) => s.replace(/\s+/g, ' ').trim();
function decls(body) {
  const m = {};
  for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) m[d[1]] = norm(d[2]);
  return m;
}

const tokensHit = find((n) => n.prelude === '@layer tokens')[0];
const tokensNode = tokensHit && tokensHit.node;
const lightNode = tokensNode && tokensNode.children.find((n) => n.prelude === ':root');
// Compare preludes with quotes and whitespace normalised, so formatting changes don't hide a block.
const canon = (p) => p.replace(/'/g, '"').replace(/\s+/g, '');
const darkAuto = find((n) => canon(n.prelude) === ':root:not([data-theme="light"])')[0];
const darkManual = find((n) => canon(n.prelude) === ':root[data-theme="dark"]')[0];
const darkAutoNode = darkAuto && darkAuto.node;
const darkManualNode = darkManual && darkManual.node;
const bodyOf = (n) => (n ? ownBody(n) : '');

test('token blocks exist where the plan says', () => {
  assert.ok(tokensNode, '@layer tokens block missing');
  assert.ok(lightNode, 'bare :root block missing inside @layer tokens');
  assert.ok(darkAuto, ':root:not([data-theme="light"]) block missing');
  assert.ok(darkManual, ':root[data-theme="dark"] block missing');
});

const light = decls(bodyOf(lightNode));
const darkA = decls(bodyOf(darkAutoNode));
const darkB = decls(bodyOf(darkManualNode));

test('@layer order puts utilities last', () => {
  const order = /@layer\s+([\w\s,-]+);/.exec(clean);
  assert.ok(order, 'no @layer order statement found');
  const names = order[1].split(',').map((x) => x.trim());
  assert.strictEqual(names[names.length - 1], 'utilities', 'layer order was ' + names.join(', '));
});

test('dark blocks are identical after whitespace normalisation', () => {
  assert.ok(Object.keys(darkA).length > 10, 'dark block looks empty');
  assert.ok(darkAutoNode && darkManualNode, 'both dark blocks must exist');
  assert.strictEqual(norm(ownBody(darkAutoNode)), norm(ownBody(darkManualNode)));
});

test('dark blocks sit inside a screen media query, so print stays light', () => {
  assert.ok(darkAuto && darkManual, 'both dark blocks must exist');
  const a = darkAuto.parents.map((p) => p.prelude);
  const b = darkManual.parents.map((p) => p.prelude);
  assert.ok(a.some((p) => /^@media\s+screen\b/.test(p) && /prefers-color-scheme:\s*dark/.test(p)),
    'auto dark block must be in @media screen and (prefers-color-scheme: dark); got ' + a.join(' > '));
  assert.ok(b.some((p) => /^@media\s+screen\b/.test(p)), 'manual dark block must be in @media screen; got ' + b.join(' > '));
});

// custom properties declared anywhere outside the three token blocks (component scoped)
const tokenBlocks = [lightNode, darkAutoNode, darkManualNode].filter(Boolean);
const scoped = new Set();
walk(tree, (n) => {
  if (tokenBlocks.includes(n)) return;
  for (const name of Object.keys(decls(ownBody(n)))) scoped.add(name);
});
const declaredAnywhere = new Set(Array.from(clean.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1]));
const used = new Set(Array.from(clean.matchAll(/var\(\s*(--[\w-]+)/g), (m) => m[1]));

test('every global token is defined in the light :root block', () => {
  const missing = [];
  for (const n of new Set([...Object.keys(darkA), ...Object.keys(darkB)])) if (!(n in light)) missing.push(n + ' (dark only)');
  for (const n of used) if (!(n in light) && !scoped.has(n)) missing.push(n + ' (used, not scoped)');
  assert.deepStrictEqual(missing, []);
});

test('every var() refers to a property declared in ui.css', () => {
  assert.deepStrictEqual([...used].filter((n) => !declaredAnywhere.has(n)), []);
});

test('component-scoped properties are the expected ones', () => {
  for (const n of ['--party', '--stack-gap', '--cluster-gap', '--grid-min']) assert.ok(scoped.has(n), n + ' should be scoped');
});

// ---- helpers live only in the utilities layer ----
// The utilities layer also holds class-level print rules for layout and component classes, so only
// the single-purpose helpers are listed here. Each must be defined in the layer and appear nowhere else.
const HELPERS = ['sr-only', 'list-reset', 'text-muted', 'text-caption', 'text-small', 'lead', 'eyebrow-label', 'h1--xl', 'h1--display', 'h2--section', 'h2--lg', 'hide-sm', 'no-print', 'mono'];
const utilitiesNode = (find((n) => n.prelude === '@layer utilities')[0] || {}).node;
const classesIn = (selector) => Array.from(selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g), (m) => m[1]);

test('every helper class appears only inside @layer utilities', () => {
  assert.ok(utilitiesNode, '@layer utilities block missing');
  const inLayer = new Set();
  const outside = [];
  walk(tree, (n, parents) => {
    if (n.prelude.startsWith('@')) return;
    const hit = classesIn(n.prelude).filter((c) => HELPERS.includes(c));
    if (parents.includes(utilitiesNode)) hit.forEach((c) => inLayer.add(c));
    else hit.forEach((c) => outside.push('.' + c + ' in "' + n.prelude + '"'));
  });
  assert.deepStrictEqual(HELPERS.filter((h) => !inLayer.has(h)), [], 'helpers missing from @layer utilities');
  assert.deepStrictEqual(outside, []);
});

// ---- no literal colours outside the token blocks ----
let rest = clean;
for (const n of [...tokenBlocks].sort((x, y) => y.open - x.open)) {
  rest = rest.slice(0, n.open) + ' '.repeat(n.close - n.open) + rest.slice(n.close);
}
rest = rest.replace(/url\([^)]*\)/g, 'url()');
const NAMED = ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
  'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen ' +
  'darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray ' +
  'darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia ' +
  'gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender ' +
  'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink ' +
  'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
  'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
  'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
  'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red ' +
  'rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow ' +
  'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' ');

function namedHits(text) {
  const hits = [];
  const noStrings = text.replace(/'[^']*'|"[^"]*"/g, '""');
  for (const d of noStrings.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]+)/g)) {
    for (const tok of d[2].split(/[\s,()\/]+/)) {
      if (NAMED.includes(tok.toLowerCase())) hits.push(`${d[1]}: ${tok}`);
    }
  }
  return hits;
}

test('no #hex colours outside the token blocks', () => {
  const hits = Array.from(rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g), (m) => m[0]);
  assert.deepStrictEqual(hits, []);
});

test('no rgb()/rgba()/hsl()/hsla() outside the token blocks', () => {
  const hits = Array.from(rest.matchAll(/\b(?:rgba?|hsla?)\s*\(/gi), (m) => m[0]);
  assert.deepStrictEqual(hits, []);
});

test('no named colours as values outside the token blocks', () => {
  assert.deepStrictEqual(namedHits(rest), []);
});

test('named-colour check flags values but not property names (self-check)', () => {
  assert.deepStrictEqual(namedHits('a{white-space:nowrap;color:white;border:1px solid Black}'),
    ['color: white', 'border: Black']);
});

// ---- WCAG contrast ----
function resolve(name, theme, seen = []) {
  if (seen.includes(name)) throw new Error('cycle at ' + name);
  const map = theme === 'dark' ? { ...light, ...darkA } : light;
  const v = map[name];
  if (v === undefined) throw new Error(`${name} is not defined in the ${theme} theme`);
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  return m ? resolve(m[1], theme, seen.concat(name)) : v;
}
function lum(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error('not a 6-digit hex: ' + hex);
  const c = [0, 2, 4].map((i) => parseInt(m[1].substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

for (const [kind, min] of [['text', 4.5], ['ui', 3]]) {
  for (const [fg, bg] of pairs[kind]) {
    for (const theme of ['light', 'dark']) {
      test(`contrast ${kind} >= ${min}: ${fg} on ${bg} (${theme})`, () => {
        const f = resolve(fg, theme);
        const b = resolve(bg, theme);
        const r = ratio(f, b);
        assert.ok(r >= min, `${fg} ${f} on ${bg} ${b} in ${theme} theme is ${r.toFixed(2)}:1, needs ${min}:1`);
      });
    }
  }
}
