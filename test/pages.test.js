'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { WEB, UI_DIR } = require('../test-support/paths');

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
const ASSIGN = /(?:\+|\|\||\?\?|&&)?=(?!=)/.source;
const SINK = new RegExp([
  /\.\s*(?:inner|outer)HTML\s*/.source + ASSIGN,
  /\[\s*['"`](?:inner|outer)HTML['"`]\s*\]\s*/.source + ASSIGN,
  /\b(?:inner|outer)HTML\s*:/.source, // Object.assign(el, { innerHTML: x })
  /\bsrcdoc\b/.source,
  /\bsetAttribute\(\s*['"`](?:srcdoc|on\w+)/.source,
  /\bparseHTMLUnsafe\b/.source,
  /\bparseFromString\b/.source,
  /\bsetHTMLUnsafe\s*\(/.source,
  /\bcreateContextualFragment\s*\(/.source,
  /\binsertAdjacentHTML\s*\(/.source,
  /\bdocument\s*\.\s*write(?:ln)?\s*\(/.source,
  /\[\s*['"`](?:setHTMLUnsafe|createContextualFragment|insertAdjacentHTML|write|writeln)['"`]\s*\]\s*\(/.source,
].join('|'));
// Hand-building a frozen strings array with a .raw, the shape that forges a UI.html template.
// A heuristic that flags the common shapes, not a boundary.
const FORGERY = (src) => /\.raw\b|\braw\s*:|['"`]raw['"`]/.test(src) && /(?:Object|Reflect)\s*\.\s*(?:freeze|defineProperty|defineProperties|preventExtensions)\b/.test(src);

test('the sink lint catches each form and ignores UI.render', () => {
  for (const bad of [
    'el.innerHTML = x', 'el.innerHTML=x', 'el.innerHTML += x', 'el .innerHTML\n = x',
    'el.outerHTML = x', 'el.outerHTML += x', "el['innerHTML'] = x", 'el["innerHTML"] += x', "el['outerHTML'] = x",
    'el.innerHTML ||= x', 'el.innerHTML ??= x', 'el.innerHTML &&= x', "el['innerHTML'] ||= x",
    'Object.assign(el, { innerHTML: x })', 'Object.assign(el, { outerHTML : x })',
    'f.srcdoc = x', 'iframe.setAttribute("srcdoc", x)', "el.setAttribute('onclick', x)", 'el.setAttribute( "onerror", x)',
    'Document.parseHTMLUnsafe(x)', 'new DOMParser().parseFromString(x, "text/html")',
    'el.insertAdjacentHTML("beforeend", x)', "el['insertAdjacentHTML']('beforeend', x)",
    'document.write(x)', 'document.writeln(x)', 'document . write (x)', "document['write'](x)", "d['writeln'](x)",
    'range.createContextualFragment(x)', "range['createContextualFragment'](x)",
    'el.setHTMLUnsafe(x)', "el['setHTMLUnsafe'](x)",
  ]) assert.ok(SINK.test(bad), 'should catch: ' + JSON.stringify(bad));
  for (const ok of ['UI.render(el, UI.html`<p>x</p>`)', 'if (el.innerHTML == "") {}', 'el.textContent = x', 'var innerHTML = 1', 'el.write(x)', 'el.setAttribute("title", x)', 'el.setAttribute("class", x)']) {
    assert.ok(!SINK.test(ok), 'should not match: ' + JSON.stringify(ok));
  }
  assert.ok(FORGERY('var s = Object.freeze(["a"]); s.raw = s;'));
  assert.ok(FORGERY('Object.defineProperty(a, "raw", {})'));
  assert.ok(FORGERY('Object.defineProperties(a, { raw: {} })'));
  assert.ok(FORGERY('Object.preventExtensions(s); s.raw = s'));
  assert.ok(FORGERY('Reflect.defineProperty(a, "raw", {})'));
  assert.ok(!FORGERY('Object.freeze(x)') && !FORGERY('x.raw'));
});

// Scanned: every web/ui/*.js, plus every same-origin script a ui.css page loads. Only ui.js is
// skipped (by full path): it holds the one sanctioned sink (UI.render). Everything else, theme.js included, is linted.
const SKIP = new Set([path.join(UI_DIR, 'ui.js')]);
const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i; // http:, data:, protocol-relative: not ours to read
// Resolve a src the way a browser would for a page served from its path under web/.
function resolveSrc(page, src) {
  const clean = src.split(/[?#]/)[0];
  const base = src.startsWith('/') ? WEB : path.dirname(page);
  return path.join(base, ...clean.split('/').filter(Boolean));
}
function scriptSrcs(html) {
  return [...html.matchAll(SCRIPT_SRC)].map((m) => (m[1] ?? m[2] ?? m[3]).trim()).filter((v) => !HAS_SCHEME.test(v));
}
function scannedScripts() {
  const files = new Set(fs.readdirSync(UI_DIR).filter((n) => n.endsWith('.js')).map((n) => path.join(UI_DIR, n)));
  const missing = [];
  for (const f of uiPages) {
    for (const src of scriptSrcs(read(f))) {
      const p = resolveSrc(f, src);
      if (fs.existsSync(p)) files.add(p);
      else missing.push(rel(f) + ' -> ' + src);
    }
  }
  for (const p of SKIP) files.delete(p);
  return { files: [...files], missing };
}
const { files: scripts, missing: missingScripts } = scannedScripts();

test('every same-origin script a ui.css page loads resolves to a file', () => {
  assert.deepStrictEqual(missingScripts, []);
});

test('script src resolution handles quoting, absolute and relative paths, and schemes', () => {
  const html = `<script src="/ui/a.js"></script><script src='b.js'></script><script src=c.js></script>
    <script defer src="https://x.test/d.js"></script><script src="//x.test/e.js"></script><script src="data:text/javascript,1"></script>`;
  assert.deepStrictEqual(scriptSrcs(html), ['/ui/a.js', 'b.js', 'c.js']);
  assert.strictEqual(resolveSrc(path.join(UI_DIR, 'index.html'), 'theme.js?v=1'), path.join(UI_DIR, 'theme.js'));
  assert.strictEqual(resolveSrc(path.join(UI_DIR, 'index.html'), '/ui/theme.js'), path.join(UI_DIR, 'theme.js'));
  assert.strictEqual(resolveSrc(path.join(WEB, 'room.html'), 'ui/ui.js'), path.join(UI_DIR, 'ui.js'));
});

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

// Regex literals on purpose: a RegExp built from a '\b' string literal silently loses its escape and matches nothing.
function snippetCounts(src) {
  const tally = (re) => {
    const m = {};
    for (const x of src.matchAll(re)) m[x[1]] = (m[x[1]] || 0) + 1;
    return m;
  };
  return { shown: tally(/\bdata-snippet\s*=\s*"([^"]*)"/g), held: tally(/\bdata-snippet-for\s*=\s*"([^"]*)"/g) };
}
function snippetProblems(src) {
  const { shown, held } = snippetCounts(src);
  assert.ok(Object.keys(shown).length > 0, 'found no data-snippet attributes');
  assert.ok(Object.keys(held).length > 0, 'found no data-snippet-for attributes');
  const problems = [];
  for (const id of new Set([...Object.keys(shown), ...Object.keys(held)])) {
    if (shown[id] !== 1 || held[id] !== 1) problems.push(id + ' (examples ' + (shown[id] || 0) + ', holders ' + (held[id] || 0) + ')');
  }
  return problems;
}

test('style guide snippets pair up: each data-snippet has exactly one data-snippet-for, and vice versa', () => {
  assert.deepStrictEqual(snippetProblems(read(guide)), []);
});

test('the snippet pairing check fails on a duplicated id and on an orphan', () => {
  const ok = '<pre data-snippet="a"></pre><div data-snippet-for="a"></div>';
  assert.deepStrictEqual(snippetProblems(ok), []);
  assert.deepStrictEqual(snippetProblems(ok + '<pre data-snippet="a"></pre>'), ['a (examples 2, holders 1)']);
  assert.deepStrictEqual(snippetProblems(ok + '<div data-snippet-for="a"></div>'), ['a (examples 1, holders 2)']);
  assert.deepStrictEqual(snippetProblems(ok + '<pre data-snippet="b"></pre>'), ['b (examples 1, holders 0)']);
  assert.deepStrictEqual(snippetProblems(ok + '<div data-snippet-for="c"></div>'), ['c (examples 0, holders 1)']);
  assert.throws(() => snippetProblems('<p>nothing</p>'), /found no data-snippet/);
});
