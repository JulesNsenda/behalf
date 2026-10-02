'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, UI_JS } = require('../test-support/paths');
const UI = require(UI_JS);
const Markdown = require(path.join(ROOT, 'web', 'js', 'markdown.js'));

const md = (src) => String(Markdown.render(src, UI));

// ---- features ----
test('headings h1 to h3', () => {
  assert.strictEqual(md('# One'), '<h1>One</h1>');
  assert.strictEqual(md('## Two'), '<h2>Two</h2>');
  assert.strictEqual(md('### Three'), '<h3>Three</h3>');
});

test('paragraphs join soft-wrapped lines and split on blank lines', () => {
  assert.strictEqual(md('a\nb\n\nc'), '<p>a b</p><p>c</p>');
});

test('inline code, bold and em', () => {
  assert.strictEqual(md('a `x` **y** *z* b'), '<p>a <code>x</code> <b>y</b> <em>z</em> b</p>');
});

test('fenced code is text with no inline formatting', () => {
  assert.strictEqual(md('```json\n{"a": **b**, "c": `d`}\n# no\n```'),
    '<pre><code>{&quot;a&quot;: **b**, &quot;c&quot;: `d`}\n# no</code></pre>');
});

test('pipe table with header row', () => {
  assert.strictEqual(md('| A | B |\n|---|---|\n| `1` | **2** |\n| 3 | 4 |'),
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>' +
    '<tr><td><code>1</code></td><td><b>2</b></td></tr><tr><td>3</td><td>4</td></tr></tbody></table>');
});

test('a table without a separator row keeps its first row as the header and drops nothing', () => {
  assert.strictEqual(md('| A | B |\n| 1 | 2 |\n| 3 | 4 |'),
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>' +
    '<tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>');
  assert.strictEqual(md('| A | B |\n| :--- | ---: |\n| 1 | 2 |'),
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
});

test('switching between bullet and numbered items starts a new list', () => {
  assert.strictEqual(md('- a\n- b\n1. c\n2. d\n- e'),
    '<ul><li>a</li><li>b</li></ul><ol><li>c</li><li>d</li></ol><ul><li>e</li></ul>');
});

test('unordered and ordered lists with continuation lines', () => {
  assert.strictEqual(md('- a\n  more\n- b'), '<ul><li>a more</li><li>b</li></ul>');
  assert.strictEqual(md('1. a\n2. b *c*'), '<ol><li>a</li><li>b <em>c</em></li></ol>');
});

test('stray hash lines do not stall the parser', () => {
  assert.strictEqual(md('#nospace\n#### four'), '<p>#nospace</p><p>#### four</p>');
});

test('null and empty input render nothing', () => {
  assert.strictEqual(md(''), '');
  assert.strictEqual(md(null), '');
});

// ---- escaping ----
const PAYLOADS = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '" onmouseover="x'];

function sources(p) {
  return {
    heading: '## ' + p,
    list: '- ' + p,
    ordered: '1. ' + p,
    table: '| ' + p + ' |\n|---|\n| ' + p + ' |',
    code: '```\n' + p + '\n```',
    paragraph: p,
    inlineCode: '`' + p + '`',
    bold: '**' + p + '**',
  };
}

// The assertion shared by the real run and the broken-renderer self-test.
function assertEscaped(out, p, label) {
  assert.ok(!/<(script|img)\b/i.test(out), label + ': raw tag in ' + out);
  assert.ok(!out.includes('" onmouseover="'), label + ': raw quote breakout in ' + out);
  assert.ok(out.includes(UI.esc(p)) || p.includes('*'), label + ': payload not present as escaped text');
}

test('hostile text is escaped in every position', () => {
  for (const p of PAYLOADS) {
    for (const [name, src] of Object.entries(sources(p))) assertEscaped(md(src), p, name);
  }
});

test('javascript: text stays inert text', () => {
  const out = md('[click](javascript:alert(1)) and javascript:alert(1)');
  assert.ok(!/<a\b/i.test(out));
  assert.ok(!/href/i.test(out));
  assert.ok(out.includes('javascript:alert(1)'));
});

test('escaping assertions can fail: a broken renderer is caught', () => {
  const broken = (src) => '<p>' + src + '</p>'; // string-to-markup, no escaping
  for (const p of PAYLOADS) {
    assert.throws(() => assertEscaped(broken(p), p, 'broken'), assert.AssertionError);
  }
  // A renderer that escapes tags but not quotes is caught by the breakout check.
  assert.throws(() => assertEscaped('<p>" onmouseover="x</p>', '" onmouseover="x', 'half'), assert.AssertionError);
});

// ---- balance ----
function balanced(out) {
  const stack = [];
  for (const m of out.matchAll(/<(\/?)([a-z0-9]+)>/g)) {
    if (m[1]) assert.strictEqual(stack.pop(), m[2], 'unbalanced: ' + out);
    else stack.push(m[2]);
  }
  assert.deepStrictEqual(stack, [], 'unclosed: ' + out);
}

test('nested and unmatched emphasis never produces unbalanced tags', () => {
  const cases = [
    '**a *b* c**', '*a **b** c*', '***x***', '**a', '*a', 'a**', '** **', '**', '*', '****',
    '`**a*`', '**`a`**', '*a* **b', '**a** *', '`a', 'a ` b ` c', '2 * 3 * 4',
  ];
  for (const c of cases) {
    for (const src of [c, '# ' + c, '- ' + c, '| ' + c + ' |\n|-|\n| ' + c + ' |']) balanced(md(src));
  }
});

// ---- SafeHtml ----
test('render returns SafeHtml that UI.render accepts', () => {
  const safe = Markdown.render('# Hi <b>', UI);
  const el = { localName: 'div', innerHTML: '' };
  UI.render(el, safe);
  assert.strictEqual(el.innerHTML, '<h1>Hi &lt;b&gt;</h1>');
  assert.throws(() => UI.render(el, '<h1>x</h1>'), TypeError);
});

// ---- the real spec ----
test('the real SPEC.md renders, with every h2 present', () => {
  const src = fs.readFileSync(path.join(ROOT, 'spec', 'SPEC.md'), 'utf8').replace(/\r\n/g, '\n');
  let out;
  assert.doesNotThrow(() => { out = md(src); });
  const inFence = [];
  let fenced = false;
  for (const l of src.split('\n')) {
    if (l.startsWith('```')) fenced = !fenced;
    else if (!fenced && l.startsWith('## ')) inFence.push(l);
  }
  assert.ok(inFence.length > 0);
  assert.strictEqual((out.match(/<h2>/g) || []).length, inFence.length);
  balanced(out.replace(/<(\/?)(pre|code)>/g, '<$1$2>'));
});
