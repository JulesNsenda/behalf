'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { WEB, UI_DIR } = require('./helpers/paths');

function htmlFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...htmlFiles(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

// Every scanned file is read once.
const sources = new Map();
const read = (f) => {
  if (!sources.has(f)) sources.set(f, fs.readFileSync(f, 'utf8'));
  return sources.get(f);
};
const rel = (f) => path.relative(WEB, f);

const OLD_CSS = /<link\b[^>]*href\s*=\s*["'](?:\.?\/)?style\.css(?:[?#][^"']*)?["']/i;
const UI_CSS = /<link\b[^>]*href\s*=\s*["'](?:\/ui\/|(?:\.\/)?ui\/)ui\.css(?:[?#][^"']*)?["']/i;

const allPages = htmlFiles(WEB);
const guide = path.join(UI_DIR, 'index.html');
const uiPages = allPages.filter((f) => UI_CSS.test(read(f)));

test('no page links both /style.css and /ui/ui.css', () => {
  assert.ok(allPages.length > 0, 'found no html files under web/');
  assert.deepStrictEqual(allPages.filter((f) => OLD_CSS.test(read(f)) && UI_CSS.test(read(f))).map(rel), []);
});

test('the style guide is among the pages that link /ui/ui.css', () => {
  assert.ok(uiPages.includes(guide));
});

test('style guide loads /ui/ui.css and not /style.css', () => {
  const s = read(guide);
  assert.ok(UI_CSS.test(s), 'must link /ui/ui.css');
  assert.ok(!OLD_CSS.test(s), 'must not link /style.css');
});

// ---- HTML sinks ----
// Every way a page script could put a string into the DOM as markup. UI.render is the one sink.
const SINK = new RegExp([
  /\.\s*(?:inner|outer)HTML\s*\+?=(?!=)/,
  /\[\s*['"`](?:inner|outer)HTML['"`]\s*\]\s*\+?=(?!=)/,
  /\binsertAdjacentHTML\s*\(/,
  /\[\s*['"`]insertAdjacentHTML['"`]\s*\]\s*\(/,
  /\bdocument\s*\.\s*write(?:ln)?\s*\(/,
  /\bcreateContextualFragment\s*\(/,
  /\bsetHTMLUnsafe\s*\(/,
].map((r) => r.source).join('|'));
// The deliberate UI.html forgery shape: hand-building a frozen strings array with a .raw.
const FORGERY = (src) => /\.raw\b|['"`]raw['"`]/.test(src) && /Object\s*\.\s*(?:freeze|defineProperty)\b/.test(src);

test('the sink lint catches each form and ignores UI.render', () => {
  for (const bad of [
    'el.innerHTML = x', 'el.innerHTML=x', 'el.innerHTML += x', 'el .innerHTML\n = x',
    'el.outerHTML = x', 'el.outerHTML += x', "el['innerHTML'] = x", 'el["innerHTML"] += x', "el['outerHTML'] = x",
    'el.insertAdjacentHTML("beforeend", x)', "el['insertAdjacentHTML']('beforeend', x)",
    'document.write(x)', 'document.writeln(x)', 'document . write (x)',
    'range.createContextualFragment(x)', 'el.setHTMLUnsafe(x)',
  ]) assert.ok(SINK.test(bad), 'should catch: ' + JSON.stringify(bad));
  for (const ok of ['UI.render(el, UI.html`<p>x</p>`)', 'if (el.innerHTML == "") {}', 'el.textContent = x', 'var innerHTML = 1', 'el.write(x)']) {
    assert.ok(!SINK.test(ok), 'should not match: ' + JSON.stringify(ok));
  }
  assert.ok(FORGERY('var s = Object.freeze(["a"]); s.raw = s;'));
  assert.ok(FORGERY('Object.defineProperty(a, "raw", {})'));
  assert.ok(!FORGERY('Object.freeze(x)') && !FORGERY('x.raw'));
});

// Scanned: every web/ui/*.js, plus every same-origin script a ui.css page loads. ui.js is the
// sink itself and theme.js is its own tested file, so both are skipped.
const SKIP = new Set(['ui.js', 'theme.js']);
function scannedScripts() {
  const files = new Set(fs.readdirSync(UI_DIR).filter((n) => n.endsWith('.js') && !SKIP.has(n)).map((n) => path.join(UI_DIR, n)));
  for (const f of uiPages) {
    for (const m of read(f).matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](\/[^"'?#]*)(?:[?#][^"']*)?["']/gi)) {
      if (m[1].startsWith('//')) continue;
      const p = path.join(WEB, ...m[1].split('/').filter(Boolean));
      if (SKIP.has(path.basename(p))) continue;
      if (fs.existsSync(p)) files.add(p);
    }
  }
  return [...files];
}
const scripts = scannedScripts();

// ---- lint rules ----
// [name, files to scan, does the source break the rule]. Keeps a future strict style-src CSP
// possible: page CSS goes in a linked file.
const RULES = [
  ['pages linking /ui/ui.css have no inline scripts', uiPages, (s) => /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(s)],
  ['pages linking /ui/ui.css have no inline event handler attributes', uiPages, (s) => /<[a-z][^>]*\son[a-z]+\s*=/i.test(s)],
  ['pages linking /ui/ui.css do not hard-code dropkit', uiPages, (s) => /dropkit/i.test(s)],
  ['pages linking /ui/ui.css have no inline style attributes', uiPages, (s) => /\sstyle\s*=/i.test(s)],
  ['pages linking /ui/ui.css have no inline <style> blocks', uiPages, (s) => /<style[\s>]/i.test(s)],
  ['no HTML sink in pages linking /ui/ui.css or in the scripts they load (UI.render only)', [...uiPages, ...scripts], (s) => SINK.test(s)],
  ['no UI.html forgery shape (.raw with Object.freeze/defineProperty) in scanned scripts', scripts, FORGERY],
];
for (const [name, files, breaks] of RULES) {
  test(name, () => {
    assert.ok(files.length > 0, 'scanned no files');
    assert.deepStrictEqual(files.filter((f) => breaks(read(f))).map(rel), []);
  });
}

test('style guide snippets pair up: each data-snippet has exactly one data-snippet-for, and vice versa', () => {
  const src = read(guide);
  const count = (attr) => {
    const m = {};
    for (const x of src.matchAll(new RegExp('\b' + attr + '\s*=\s*"([^"]*)"', 'g'))) m[x[1]] = (m[x[1]] || 0) + 1;
    return m;
  };
  const shown = count('data-snippet');
  const held = count('data-snippet-for');
  const problems = [];
  for (const id of new Set([...Object.keys(shown), ...Object.keys(held)])) {
    if (shown[id] !== 1 || held[id] !== 1) problems.push(id + ' (examples ' + (shown[id] || 0) + ', holders ' + (held[id] || 0) + ')');
  }
  assert.deepStrictEqual(problems, []);
});
