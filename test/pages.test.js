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

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (/\.m?js$/.test(e.name)) out.push(p);
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
  // web/js/ holds the page scripts and views, at any depth; it may not exist yet.
  const JS_DIR = path.join(WEB, 'js');
  if (fs.existsSync(JS_DIR)) for (const f of jsFiles(JS_DIR)) files.add(f);
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

// ---- URL sinks ----
// Every way a script could navigate or point an element at a URL. The argument must be UI.url(...)
// or a complete string literal whose first character after the leading "/" is a path character
// ("//host" and "/\host" are protocol-relative, "/${x}" and '/' + x are data-controlled).
// Regex literals on purpose (see snippetCounts).
const ASSIGN_OP = /\s*(?:\+|\|\||\?\?|&&)?=(?![=>])/.source;
// Sinks whose argument (the text after the match) is checked by urlArgOk.
const URL_SINKS = [
  /\.\s*(?:href|src|action|formaction|poster|srcset)/.source + ASSIGN_OP, // el.href =, el.src =, el.formAction =
  /\blocation\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)?/.source + ASSIGN_OP, // location =, window.location =, location.hash =
  /\blocation\s*\.\s*(?:assign|replace)\s*\(/.source,
  /\[\s*['"`](?:href|src|action|formaction|poster|srcset)['"`]\s*\]/.source + ASSIGN_OP, // el['href'] =
  /Object\s*\.\s*assign\s*\([^;]*?[{,]\s*(?:['"`]?(?:href|src|action|formaction|poster|srcset)['"`]?|\[\s*['"`](?:href|src|action|formaction|poster|srcset)['"`]\s*\])\s*:/.source,
  /\bsetAttribute\s*\(\s*['"`](?:href|src|action|formaction)['"`]\s*,/.source,
  /\b(?:window|self|globalThis|top|parent)\s*\.\s*open\s*\(/.source,
  /(?<![\w$.])open\s*\(/.source,
].map((x) => new RegExp(x, 'gi'));
// setAttribute whose attribute name is not a plain literal could name href/src at runtime: always a hit.
const SET_ATTR_DYNAMIC = /\bsetAttribute\s*\((?!\s*(['"`])[A-Za-z-]*\1\s*[,)])/gi;
// Index just past the ")" matching the "(" at src[open], skipping string literals; -1 if unbalanced.
function closeParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return -1;
}
const APPENDED = /^\s*(?:\+|`|\.\s*concat\b)/;
function urlArgOk(rest) {
  const lit = /^\s*(['"`])\/[A-Za-z0-9_.~-]/.exec(rest);
  if (lit) {
    const start = lit[0].length - 2; // the opening quote
    const q = lit[1];
    let i = start + 1;
    for (; i < rest.length && rest[i] !== q; i++) if (rest[i] === '\\') i++;
    if (i >= rest.length) return false;
    const body = rest.slice(start + 1, i);
    return !(q === '`' && body.includes('${')) && !APPENDED.test(rest.slice(i + 1));
  }
  const call = /^\s*UI\.url\s*\(/.exec(rest);
  if (call) {
    const end = closeParen(rest, call[0].length - 1);
    return end !== -1 && !APPENDED.test(rest.slice(end));
  }
  return false;
}
function urlSinkHits(src) {
  const hits = [];
  for (const re of URL_SINKS) {
    for (const m of src.matchAll(re)) {
      if (!urlArgOk(src.slice(m.index + m[0].length))) hits.push(m[0]);
    }
  }
  for (const m of src.matchAll(SET_ATTR_DYNAMIC)) hits.push(m[0]);
  return hits;
}

// ---- template lint ----
// Templates only ever interpolate into text and quoted attribute values; URL attributes only take UI.url(...).
// 1. href/src/action/formaction/poster/srcset values: a quoted or backtick value with ${ that is not exactly ${UI.url(...)}, or an unquoted ${.
const TPL_URL_ATTR = [
  /\b(?:href|src|action|formaction|poster|srcset)\s*=\s*(["'`])(?!\$\{\s*UI\.url\s*\()(?:(?!\1)[^])*?\$\{/i,
  /\b(?:href|src|action|formaction|poster|srcset)\s*=\s*(["'`])\$\{\s*UI\.url\s*\((?:(?!\1)[^])*?\)\s*\}(?!\1)/i, // something appended after the call
  /\b(?:href|src|action|formaction|poster|srcset)\s*=\s*\$\{/i,
];
// 2. <${x}>, </${x}>, <h${n}>, </h${n}> and ${...} where an attribute name goes (<div ${a}="1">, <input disabled ${a}>).
const TPL_TAG_NAME = /<\/?[A-Za-z][A-Za-z0-9-]*\$\{|<\/?\$\{/;
const TPL_ATTR_NAME = /<[A-Za-z][\w-]*(?:\s+[\w:@.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+))?)*\s+\$\{/;
// 3. Unquoted attribute value: =${x}
const TPL_UNQUOTED = /=\s*\$\{/;
const templateHits = (s) => TPL_URL_ATTR.some((re) => re.test(s)) || TPL_TAG_NAME.test(s) || TPL_ATTR_NAME.test(s) || TPL_UNQUOTED.test(s);

test('the URL sink lint catches each bad form and allows UI.url and same-origin literals', () => {
  for (const bad of [
    'a.href = x', 'a.href=x', 'a.href += x', 'a.href ||= x', 'a . href = x', 'a.href = "http://x.test"', "a.href = '//evil.test'",
    'location.href = x', 'location.assign(x)', 'location.replace(x)', 'location . assign (x)',
    'window.location.assign(x)', 'window.location.href = x',
    "el.setAttribute('href', x)", 'el.setAttribute("src", x)', 'el.setAttribute( `href` , x)',
    'window.open(x)', 'window.open("https://x.test")', 'window . open (x)',
    'a.href = urlOf(x)', 'location.href = "relative/path"',
    // tightened allow-list
    "a.href = '/' + x", 'a.href = `/${x}`', "a.href = '/\\t/evil'", "a.href = '/\\\\evil'", 'a.href = UI.url(a) + b', 'a.href = UI.url(a) + `/${b}`',
    'a.href = UI.url(a)`x`', 'a.href = UI.url(a\n', "a.href = '/room/' + id", 'location.replace(`/room/${id}`)', "a.href = '/room/abc' + x", 'a.href = "/\x01x"',
    // more sinks
    'location = x', 'window.location = x', 'document.location = x', 'location=x', 'location += x', 'location.hash = x', 'window.location.search = x',
    'f.src = x', 'f.action = x', 'f.formAction = x', 'f.formaction = x', 'f.poster = x', 'f.srcset = x', 'f . src ||= x',
    "a['href'] = x", 'a["src"] = x', 'a[`action`] = x', "a['href'] += x", "a ['formAction'] = x",
    'Object.assign(a, { href: x })', 'Object.assign(a, { src : x })', "Object.assign(a, { 'href': x })", 'Object.assign(a, {a: 1, src: x})', "Object.assign(a, { ['href']: x })",
    "el.setAttribute('HREF', x)", 'el.setAttribute ( "Action", x)', "el.setAttribute('formaction', x)", "el.setAttribute('formAction', x)", 'el.setAttribute\n("src", x)',
    'el.setAttribute(name, x)', 'el.setAttribute(`h${x}`, y)', 'el.setAttribute(n + "ref", y)', "el.setAttribute('title' + x, y)", 'el.setAttribute( n, y)',
    'open(x)', 'open("https://x.test")', 'self.open(x)', 'globalThis.open(x)', 'top.open(x)', 'self . open (x)', ';open(x)',
  ]) assert.ok(urlSinkHits(bad).length > 0, 'should catch: ' + JSON.stringify(bad));
  for (const ok of [
    'a.href = UI.url(x)', 'a.href=UI.url(x)', 'location.href = UI.url(x)', 'location.assign(UI.url(x))', 'location.replace( UI.url(x) )',
    "el.setAttribute('href', UI.url(x))", 'el.setAttribute("src", UI.url(x))', 'window.open(UI.url(x), "_blank")',
    "location.href = '/room/1'", 'location.assign("/start")', "el.setAttribute('href', '/ui/logo.svg')",
    "a.href = '/room/abc'", "a.href = '/room/abc';", 'a.href = UI.url(f(x, "a)b"))', 'a.href = UI.url(`/r/${id}`)', 'a.href = UI.url(a)\nfoo()', 'location.assign(UI.url(a), 1)',
    'if (a.href == b) {}', 'if (a.href === b) {}', 'if (a.href !== b) {}', 'if (location == x) {}', 'if (location === x) {}', 'if (location.hash === "#a") {}', 'if (a.src == b) {}',
    'el.setAttribute("title", x)', 'el.setAttribute("class", x)', 'el.setAttribute( "aria-label" , x)', 'var href = x', 'el.hrefs = x', 'el.srcs = x', 'x.reopen(y)', 'el.open = true', 'a.open(x)',
    'Object.assign(a, { title: x })', 'Object.assign(a, { hrefs: x })',
    'Object.assign(a, { href: UI.url(x) })', "Object.assign(a, { src: '/ui/logo.svg' })",
    "a['href'] = UI.url(x)", "a['title'] = x", 'f.src = UI.url(x)', 'f.action = "/api/x"', 'location = "/start"', 'window.location = UI.url(x)', 'document.location = "/spec"', 'document.location.pathname = "/ok"',
  ]) assert.deepStrictEqual(urlSinkHits(ok), [], 'should allow: ' + JSON.stringify(ok));
});

test('the template lint catches each bad form and ignores safe templates', () => {
  for (const bad of [
    // 1. URL attributes
    'UI.html`<a href="${u}">x</a>`', "UI.html`<a href='${u}'>x</a>`", 'UI.html`<a href=`${u}`>`', 'UI.html`<img src="${u}">`', 'UI.html`<form action="${u}">`',
    'UI.html`<button formaction="${u}">`', 'UI.html`<video poster="${u}">`', 'UI.html`<img srcset="${u} 2x">`', 'UI.html`<a href="/room/${id}">`', 'UI.html`<a href="${a}${UI.url(b)}">`',
    'UI.html`<a href = "${u}">`', 'UI.html`<a HREF="${u}">`', 'UI.html`<a href=${u}>`', 'UI.html`<img src=${u}>`', 'UI.html`<a href= ${UI.url(u)}>`',
    'UI.html`<a href="${UI.url(u)}/x">`', 'UI.html`<a href="${UI.url(u)}${v}">`', 'UI.html`<a href="${UI.url(u)}?a=1">`', "UI.html`<a href='${ UI.url(u) }x'>`",
    // 2. tag and attribute names
    'UI.html`<${tag}>x</${tag}>`', 'UI.html`<${t} class="a">`', 'UI.html`</${t}>`', 'UI.html`<h${n}>x</h${n}>`', 'UI.html`</h${n}>`', 'UI.html`<my-el${n}>`',
    'UI.html`<div ${a}="1">`', 'UI.html`<div ${a}>`', 'UI.html`<div class="x" ${a}="1">`', 'UI.html`<div class="x" ${a}>`', 'UI.html`<input disabled ${a}>`', "UI.html`<div a='1' ${a}=\"1\">`", 'UI.html`<div a=1 ${a}>`',
    'UI.html`<div\n  ${a}="1">`', 'UI.html`<div ${a}${b}="1">`', 'UI.html`<div ${a}x="1">`',
    // 3. unquoted values
    'UI.html`<div class=${c}>`', 'UI.html`<div class= ${c}>`', 'UI.html`<input value =${v}>`', 'UI.html`<p data-x=${x}>`',
  ]) assert.ok(templateHits(bad), 'should catch: ' + JSON.stringify(bad));
  for (const ok of [
    'UI.html`<p>${x}</p>`', 'UI.html`<a href="${UI.url(u)}">${t}</a>`', "UI.html`<a href='${UI.url(u)}'>${t}</a>`", 'UI.html`<a href="${ UI.url(f(a, b)) }">x</a>`',
    'UI.html`<img src="${UI.url(u)}" alt="${a}">`', 'UI.html`<a href="/spec">x</a>`', 'UI.html`<a href="#x">${t}</a>`', 'UI.html`<a href="${UI.url(u)}" class="a ${b}">x</a>`',
    'UI.html`<p class="a ${b}" title="${t}">x</p>`', 'UI.html`<p class="${a} ${b}">${x} ${y}</p>`', "UI.html`<p title='${t}'>x</p>`", 'UI.html`<p>${a} ${b}</p>`',
    'a < b', 'a<b ? `${x}` : y', 'x = `${a}<b>`', 'if (a == b) {}', 'a = b', 'var s = `${a}`', 'x = y ? `<i>${a}</i>` : ""', 'UI.html`<button disabled>x</button>`',
  ]) assert.ok(!templateHits(ok), 'should not match: ' + JSON.stringify(ok));
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
  ['no URL sink in scanned scripts takes anything but UI.url(...) or a same-origin path literal', scripts, (s) => urlSinkHits(s).length > 0],
  ['no template URL attribute (href, src, action, formaction, poster, srcset) takes anything but ${UI.url(...)}', scripts, (s) => TPL_URL_ATTR.some((re) => re.test(s))],
  ['no interpolation into a tag name (<${, </${, <h${) in scanned scripts', scripts, (s) => TPL_TAG_NAME.test(s)],
  ['no interpolation into an attribute name position in scanned scripts', scripts, (s) => TPL_ATTR_NAME.test(s)],
  ['no unquoted interpolated attribute value (=${) in scanned scripts', scripts, (s) => TPL_UNQUOTED.test(s)],
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

// ---- shared header and footer fragments ----
// Every page repeats the same site header and footers; this keeps the copies from drifting.
// The style guide is excluded: it shows header and footer variants on purpose.
const norm = (h) => h.replace(/\s+aria-current\s*=\s*(?:"page"|'page')/g, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim();
const HEADER = /<header\b[^>]*?\sclass\s*=\s*(?:"[^"]*(?<![\w-])site-header(?![\w-])[^"]*"|'[^']*(?<![\w-])site-header(?![\w-])[^']*')[^>]*>[\s\S]*?<\/header>/g;
const FOOTER_FULL = /<footer\b[^>]*?\sclass\s*=\s*(?:"[^"]*(?<![\w-])footer--full(?![\w-])[^"]*"|'[^']*(?<![\w-])footer--full(?![\w-])[^']*')[^>]*>[\s\S]*?<\/footer>/g;
const FOOTER_SLIM = /<footer\b[^>]*?\sclass\s*=\s*(?:"[^"]*(?<![\w-])footer--slim(?![\w-])[^"]*"|'[^']*(?<![\w-])footer--slim(?![\w-])[^']*')[^>]*>[\s\S]*?<\/footer>/g;
const END_SLOT = /<div\b[^>]*?\sclass\s*=\s*(?:"[^"]*(?<![\w-])site-header__end(?![\w-])[^"]*"|'[^']*(?<![\w-])site-header__end(?![\w-])[^']*')[^>]*>/;
// Remove the site-header__end slot (the one part of the header that may differ per page), nested divs included.
function stripEndSlot(html) {
  const m = END_SLOT.exec(html);
  if (!m) return html;
  let depth = 1;
  const from = m.index + m[0].length;
  for (const t of html.slice(from).matchAll(/<(\/?)div\b[^>]*>/g)) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return html.slice(0, m.index) + html.slice(from + t.index + t[0].length);
  }
  return html.slice(0, m.index); // unclosed: drop the rest rather than compare it
}
// The main nav lives inside the end slot on reading pages, so it is compared on its own: every page that
// has one must have the same one (task pages have a step label or status there instead).
const MAIN_NAV = /<nav\b[^>]*?\sclass\s*=\s*(?:"[^"]*(?<![\w-])site-header__nav(?![\w-])[^"]*"|'[^']*(?<![\w-])site-header__nav(?![\w-])[^']*')[^>]*>[\s\S]*?<\/nav>/g;
function fragments(html) {
  return {
    nav: [...html.matchAll(HEADER)].flatMap((m) => [...m[0].matchAll(MAIN_NAV)].map((n) => norm(n[0]))),
    header: [...html.matchAll(HEADER)].map((m) => norm(stripEndSlot(m[0]))),
    full: [...html.matchAll(FOOTER_FULL)].map((m) => norm(m[0])),
    slim: [...html.matchAll(FOOTER_SLIM)].map((m) => norm(m[0])),
  };
}
// The kinds (header, full, slim) whose copies differ across the given [name, html] pages.
function fragmentDrift(pages) {
  const bad = [];
  for (const kind of ['nav', 'header', 'full', 'slim']) {
    const all = pages.flatMap(([, html]) => fragments(html)[kind]);
    if (new Set(all).size > 1) bad.push(kind);
  }
  return bad;
}
const fragmentPages = uiPages.filter((f) => f !== guide).map((f) => [rel(f), read(f)]);

// Footer column of the page-migration plan. true = exactly one, false = none, 'maybe' = any number.
// nav: whether the page has the main nav (reading pages do; task pages show a step label or status instead).
// start.html: no footer on Start, a slim one on the Invite step (never a full one).
const FOOTERS = {
  'index.html': { full: true, slim: false, nav: true },
  'start.html': { full: false, slim: 'maybe', nav: false },
  'room.html': { full: false, slim: false, nav: false },
  'agreement.html': { full: false, slim: true, nav: false },
  'connect.html': { full: true, slim: false, nav: true },
  'spec.html': { full: true, slim: false, nav: true },
};
const countOk = (want, n) => (want === 'maybe' ? true : want ? n === 1 : n === 0);
// What is wrong with one page that should be on the UI library.
function pageProblems(html, want) {
  const problems = [];
  if (!UI_CSS.test(html)) problems.push('does not link /ui/ui.css');
  const f = fragments(html);
  if (f.header.length !== 1) problems.push('needs exactly one site-header (found ' + f.header.length + ')');
  // A nav of a different shape is caught by the drift check; this only asks whether there is one. Omitted nav = no check.
  if (want.nav !== undefined && (f.nav.length > 0) !== want.nav) problems.push('main nav: expected ' + (want.nav ? 'one' : 'none') + ', found ' + f.nav.length);
  for (const kind of ['full', 'slim']) {
    if (!countOk(want[kind], f[kind].length)) problems.push('footer--' + kind + ': expected ' + want[kind] + ', found ' + f[kind].length);
  }
  return problems;
}

test('site header and footers are identical on every page that links /ui/ui.css', () => {
  assert.deepStrictEqual(fragmentDrift(fragmentPages), []);
});

test('each page in the footer manifest that exists has the header and the right footers', () => {
  const bad = [];
  for (const [name, want] of Object.entries(FOOTERS)) {
    const file = path.join(WEB, name);
    if (!fs.existsSync(file)) continue; // not built yet
    const html = read(file);
    // Not migrated yet: still on the old stylesheet. Once it links ui.css (or neither), it is held to the manifest.
    if (OLD_CSS.test(html) && !UI_CSS.test(html)) continue;
    for (const p of pageProblems(html, want)) bad.push(name + ': ' + p);
  }
  assert.deepStrictEqual(bad, []);
});

test('the fragment check fails when headers or footers differ, and ignores aria-current, whitespace and the end slot', () => {
  const page = (nav, full, slim, end = '') => '<header class="site-header"><div class="site-header__inner"><nav aria-label="Main">' + nav + '</nav>' + end + '</div></header>'
    + '<footer class="footer footer--full">' + full + '</footer><footer class="footer footer--slim">' + slim + '</footer>';
  const a = page('<a href="/">Home</a>', '<p>x</p>', '<p>y</p>');
  assert.deepStrictEqual(fragmentDrift([['a', a], ['b', a]]), []);
  assert.deepStrictEqual(fragmentDrift([['a', a]]), []);
  assert.deepStrictEqual(fragmentDrift([['a', a], ['b', a.replace('<a href="/">', '<a href="/" aria-current="page">')]]), []);
  assert.deepStrictEqual(fragmentDrift([['a', a], ['b', a.replace('<a href="/">', "<a href=\"/\" aria-current='page'>")]]), []);
  assert.deepStrictEqual(fragmentDrift([['a', a], ['b', a.replace('<p>x</p>', '\n   <p>x</p>\n')]]), []);
  assert.deepStrictEqual(fragmentDrift([['a', a], ['b', a.replace('Home', 'Start')]]), ['header']);
  assert.deepStrictEqual(fragmentDrift([['a', a], ['b', a.replace('<p>x</p>', '<p>z</p>')]]), ['full']);
  assert.deepStrictEqual(fragmentDrift([['a', a], ['b', a.replace('<p>y</p>', '<p>z</p>')]]), ['slim']);
  // Drift outside the nav (brand, wrapper) is caught: the whole header is compared.
  assert.deepStrictEqual(fragmentDrift([['a', a], ['b', a.replace('site-header__inner', 'site-header__other')]]), ['header']);
  assert.deepStrictEqual(fragmentDrift([['a', a], ['b', a.replace('<nav', '<span>Behalf</span><nav')]]), ['header']);
  // The end slot may differ: single or double quotes, extra classes, nested elements.
  const endA = '<div class="site-header__end">UI library</div>';
  const endB = "<div class='x site-header__end y'><div><span>Step 2 of 3</span></div></div>";
  const withEnd = (end) => ['p', page('<a href="/">Home</a>', '<p>x</p>', '<p>y</p>', end)];
  assert.deepStrictEqual(fragmentDrift([withEnd(endA), withEnd(endB), ['c', a]]), []);
  // A lookalike class is not the end slot.
  assert.deepStrictEqual(fragmentDrift([['a', a], withEnd('<div class="site-header__end-x">z</div>')]), ['header']);
  const f = fragments(a);
  assert.deepStrictEqual([f.header.length, f.full.length, f.slim.length], [1, 1, 1]);
  // Single-quoted and multi-class markup is still found; a lookalike class is not.
  const q = fragments("<header class='x site-header'></header><footer id=f class='footer footer--full'></footer><footer class=\"footer--slimmer\"></footer>");
  assert.deepStrictEqual([q.header.length, q.full.length, q.slim.length], [1, 1, 0]);
});

test('a main nav inside the end slot is still compared across the pages that have one', () => {
  const head = (end) => '<header class="site-header"><div class="site-header__inner"><a class="brand" href="/">P</a>'
    + '<div class="site-header__end">' + end + '</div></div></header>';
  const nav = (links) => '<nav class="site-header__nav" aria-label="Main">' + links + '</nav>';
  const reading = head(nav('<a href="/connect">Connect</a><a href="/spec">Protocol</a>'));
  const task = head('<span>Step 1 of 3</span>');
  // A reading page and a task page agree (the task page has no nav); two reading pages with the same nav agree.
  assert.deepStrictEqual(fragmentDrift([['r', reading], ['t', task], ['r2', reading.replace('/connect">', '/connect" aria-current="page">')]]), []);
  // A nav that drifts on one reading page is caught, even though it sits in the end slot.
  assert.deepStrictEqual(fragmentDrift([['r', reading], ['r2', reading.replace('Protocol', 'Spec')]]), ['nav']);
  assert.strictEqual(fragments(reading).nav.length, 1);
  assert.strictEqual(fragments(task).nav.length, 0);
});

test('the page manifest check fails on a missing stylesheet, header or footer, and on the wrong footer', () => {
  const css = '<link rel="stylesheet" href="/ui/ui.css">';
  const header = '<header class="site-header"><nav></nav></header>';
  const full = '<footer class="footer footer--full"></footer>';
  const slim = '<footer class="footer footer--slim"></footer>';
  const none = { full: false, slim: false };
  const needFull = { full: true, slim: false };
  const maybeSlim = { full: false, slim: 'maybe' };
  assert.deepStrictEqual(pageProblems(css + header + full, needFull), []);
  assert.deepStrictEqual(pageProblems(css + header, none), []);
  assert.deepStrictEqual(pageProblems(css + header + slim, maybeSlim), []);
  assert.deepStrictEqual(pageProblems(css + header, maybeSlim), []);
  assert.deepStrictEqual(pageProblems(css + header + slim, { full: false, slim: true }), []);
  // A missing footer is a failure, not agreement.
  assert.deepStrictEqual(pageProblems(css + header, needFull), ['footer--full: expected true, found 0']);
  assert.deepStrictEqual(pageProblems(css + header, { full: false, slim: true }), ['footer--slim: expected true, found 0']);
  // Missing header, missing stylesheet, wrong or extra footer.
  assert.deepStrictEqual(pageProblems(css + full, needFull), ['needs exactly one site-header (found 0)']);
  assert.deepStrictEqual(pageProblems(header + full, needFull), ['does not link /ui/ui.css']);
  assert.deepStrictEqual(pageProblems(css + header + full, none), ['footer--full: expected false, found 1']);
  assert.deepStrictEqual(pageProblems(css + header + slim, needFull), ['footer--full: expected true, found 0', 'footer--slim: expected false, found 1']);
  assert.deepStrictEqual(pageProblems(css + header + full + full, needFull), ['footer--full: expected true, found 2']);
  assert.deepStrictEqual(pageProblems(css + header + full, maybeSlim), ['footer--full: expected false, found 1']);
  assert.deepStrictEqual(pageProblems(css + header + header + full, needFull), ['needs exactly one site-header (found 2)']);
  assert.deepStrictEqual(pageProblems('<p>empty</p>', needFull), ['does not link /ui/ui.css', 'needs exactly one site-header (found 0)', 'footer--full: expected true, found 0']);
});

test('the page manifest check requires the main nav where the page has one and forbids it elsewhere', () => {
  const css = '<link rel="stylesheet" href="/ui/ui.css">';
  const head = (end) => '<header class="site-header"><div class="site-header__inner"><div class="site-header__end">' + end + '</div></div></header>';
  const nav = '<nav class="site-header__nav" aria-label="Main"><a href="/">x</a></nav>';
  const none = { full: false, slim: false };
  assert.deepStrictEqual(pageProblems(css + head(nav), { ...none, nav: true }), []);
  assert.deepStrictEqual(pageProblems(css + head('<span>Step 1 of 3</span>'), { ...none, nav: false }), []);
  assert.deepStrictEqual(pageProblems(css + head('<span>Step 1 of 3</span>'), { ...none, nav: true }), ['main nav: expected one, found 0']);
  assert.deepStrictEqual(pageProblems(css + head(nav), { ...none, nav: false }), ['main nav: expected none, found 1']);
  assert.deepStrictEqual(pageProblems(css + head(nav), none), [], 'no nav entry, no check');
  for (const [name, want] of Object.entries(FOOTERS)) assert.strictEqual(typeof want.nav, 'boolean', name + ' states its nav');
});

// ---- fix pass: decisions that live in page scripts ----
test('the room scripts keep the token in the address bar: none calls replaceState', () => {
  const roomScripts = fs.readdirSync(path.join(WEB, 'js')).filter((n) => /^room[\w-]*\.js$/.test(n) && n !== 'room-view.js');
  assert.deepStrictEqual(roomScripts.sort(), ['room-chat.js', 'room-core.js', 'room-kit.js', 'room-setup.js', 'room.js']);
  for (const n of roomScripts) assert.ok(!/replaceState/.test(read(path.join(WEB, 'js', n))), n);
});

test('room.html loads the room scripts in dependency order', () => {
  const srcs = scriptSrcs(read(path.join(WEB, 'room.html'))).filter((s) => s.startsWith('/js/') || s === '/ui/ui.js');
  assert.deepStrictEqual(srcs, ['/ui/ui.js', '/js/room-view.js', '/js/links.js', '/js/room-core.js', '/js/room-kit.js', '/js/room-setup.js', '/js/room-chat.js', '/js/room.js']);
});

test('the room page has one way to render and one set of hooks: no A.apply, no late-assigned A.on* hooks', () => {
  for (const n of ['room.js', 'room-core.js', 'room-kit.js', 'room-setup.js', 'room-chat.js']) {
    const src = read(path.join(WEB, 'js', n));
    assert.ok(!/A\.apply/.test(src), n + ' calls A.apply');
    assert.ok(!/A\.on(Room|Gone|LoadError)/.test(src.replace(/^\s*\*.*$/gm, '')), n + ' uses a late A.on* hook');
  }
});

test('the invite preview opens in a new tab without an opener', () => {
  assert.match(read(path.join(WEB, 'js', 'start.js')), /href="\$\{UI\.url\(previewPath\)\}" target="_blank" rel="noopener noreferrer"/);
});

test('RoomView.str is the only place that strips format characters', () => {
  const hits = jsFiles(path.join(WEB, 'js')).filter((f) => /\p\{Cf\}/.test(read(f))).map(rel);
  assert.deepStrictEqual(hits, [path.join('js', 'room-view.js')]);
});

// ---- wave 2 regressions that live in page scripts (static checks; the DOM is covered by the runtime walkthrough) ----
// What the paths and links look like is tested on Links itself (links.test.js). This only checks that the
// pages use those builders and don't make room or agreement paths by hand.
test('page scripts build room and agreement paths through Links, never by hand', () => {
  const hits = jsFiles(path.join(WEB, 'js'))
    .filter((f) => path.basename(f) !== 'links.js')
    // Reading the id out of a path is not building a link.
    .filter((f) => /['"`]\/(?:room|brief)\//.test(read(f).replace(/roomIdFromPath\([^)]*\)/g, '')))
    .map(rel);
  assert.deepStrictEqual(hits, []);
});

test('the pages that make a room or agreement link use the Links builders', () => {
  const uses = (name, re) => assert.match(read(path.join(WEB, 'js', name)), re, name);
  uses('start.js', /Links\.previewPath\(room\.id, 'B'\)/);
  uses('home.js', /Links\.demoUrl\(res\.data\)/);
  uses('agreement.js', /Links\.roomPath\(roomId, seat\)/);
  uses('room-chat.js', /Links\.briefPath\(A\.roomId, room\.seat\)/);
  uses('room-chat.js', /Links\.demoUrl\(res\.data\)/);
  uses('room-core.js', /cred\.promptLink\(location\.origin\)/);
});

test('start.js: when the links did not come back the form is locked and the error shown', () => {
  const src = read(path.join(WEB, 'js', 'start.js'));
  const branch = src.slice(src.indexOf('if (shown) return;'), src.indexOf('// A refused passcode'));
  assert.match(branch, /lockForm\(\);/);
  assert.match(branch, /showError\(LINKS_MESSAGE\)/);
  assert.match(src, /if \(submitting \|\| created\) return;/, 'a created room never submits again');
  assert.match(src, /function lockForm\(\) \{ UI\.disableAll\(form\); \}/);
});

test('agreement.js: the address bar keeps ?seat and drops the token', () => {
  const src = read(path.join(WEB, 'js', 'agreement.js'));
  assert.match(src, /replaceState\(null, '', location\.pathname \+ Links\.seatQuery\(seat\) \+ location\.hash\)/);
  assert.ok(!/replaceState[^;]*\bt=/.test(src), 'no token goes back into the address');
});
