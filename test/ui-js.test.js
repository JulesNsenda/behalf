'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { UI_JS, THEME_JS } = require('./helpers/paths');

function freshRequire() {
  delete require.cache[require.resolve(UI_JS)];
  return require(UI_JS);
}

// No window here, so ui.js sets module.exports.
assert.strictEqual(typeof globalThis.window, 'undefined');
const UI = freshRequire();

// ---- esc ----
test('esc escapes all five characters', () => {
  assert.strictEqual(UI.esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.strictEqual(UI.esc('a & b < c'), 'a &amp; b &lt; c');
});

test('esc handles null, undefined and numbers', () => {
  assert.strictEqual(UI.esc(null), '');
  assert.strictEqual(UI.esc(undefined), '');
  assert.strictEqual(UI.esc(0), '0');
  assert.strictEqual(UI.esc(42), '42');
  assert.strictEqual(UI.esc(1.5), '1.5');
});

test('API surface is exactly esc,html,url,render,copy,toast,setTheme,getTheme', () => {
  assert.deepStrictEqual(Object.keys(UI).sort(), 'copy,esc,getTheme,html,render,setTheme,toast,url'.split(',').sort());
  assert.strictEqual(UI.raw, undefined);
});

// ---- html ----
test('html escapes interpolated strings', () => {
  assert.strictEqual(String(UI.html`<p>${'<b>&'}</p>`), '<p>&lt;b&gt;&amp;</p>');
});

test('html passes nested SafeHtml through unescaped', () => {
  const inner = UI.html`<b>${'x<y'}</b>`;
  assert.strictEqual(String(UI.html`<p>${inner}</p>`), '<p><b>x&lt;y</b></p>');
});

test('html flattens arrays recursively with mixed SafeHtml and plain strings', () => {
  const out = UI.html`<ul>${[UI.html`<li>a</li>`, '<li>b</li>', [UI.html`<li>c</li>`, ['<i>']]]}</ul>`;
  assert.strictEqual(String(out), '<ul><li>a</li>&lt;li&gt;b&lt;/li&gt;<li>c</li>&lt;i&gt;</ul>');
});

test('html renders null, undefined and false as empty; 0 and true are stringified', () => {
  assert.strictEqual(String(UI.html`[${null}][${undefined}][${false}]`), '[][][]');
  assert.strictEqual(String(UI.html`[${0}][${true}]`), '[0][true]');
  assert.strictEqual(String(UI.html`${[null, undefined, false, 0]}`), '0');
});

test('html result stringifies via toString and template coercion', () => {
  const s = UI.html`<i>x</i>`;
  assert.strictEqual(s.toString(), '<i>x</i>');
  assert.strictEqual(`${s}`, '<i>x</i>');
});

// Anything that is not a real SafeHtml must come out escaped or empty: never as markup.
const Forged = UI.html`x`.constructor;
const fromCtor = (props) => Object.assign(new Forged(), props);
const FORGERIES = [
  ['plain {__html} object', { __html: '<b>x</b>' }],
  ['object with custom toString', { toString() { return '<b>'; } }],
  ['SafeHtml constructor instance with forged properties and toString', fromCtor({ __html: '<b>x</b>', value: '<b>x</b>', toString: () => '<b>x</b>', html: '<b>x</b>' })],
  ['SafeHtml constructor instance with only a property added', fromCtor({ s: '<b>' })],
  ['bare SafeHtml constructor instance', new Forged()],
];
for (const [name, forged] of FORGERIES) {
  test(`forgery: ${name} is escaped or empty`, () => {
    const out = String(UI.html`${forged}`);
    assert.ok(!out.includes('<'), out);
  });
}

test('forgery: mutating a real SafeHtml does not change its content', () => {
  const real = UI.html`<i>ok</i>`;
  for (const k of ['__html', 'value', 's', 'str', 'html', '_v', 'toString']) {
    try { real[k] = '<script>'; } catch (e) { /* frozen */ }
  }
  assert.strictEqual(String(UI.html`${real}`), '<i>ok</i>');
});

// ---- html guard ----
function lookAlike(parts, freezeRaw = true) {
  const raw = freezeRaw ? Object.freeze(parts.slice()) : parts.slice();
  const strings = parts.slice();
  Object.defineProperty(strings, 'raw', { value: raw });
  return Object.freeze(strings);
}

test('html throws unless used as a template tag', () => {
  const withRaw = lookAlike(['a', 'b', 'c']);
  assert.throws(() => UI.html(['<b>']), TypeError);
  assert.throws(() => UI.html('<b>'), TypeError);
  assert.throws(() => UI.html(Object.freeze(['<b>'])), TypeError, 'frozen but no .raw');
  assert.throws(() => UI.html({ raw: ['<b>'], length: 1, 0: '<b>' }), TypeError, 'hand-built {raw}');
  assert.throws(() => UI.html(Object.assign(['<b>'], { raw: ['<b>'] })), TypeError, 'unfrozen array with raw');
  assert.throws(() => UI.html(lookAlike(['<b>'], false)), TypeError, 'frozen strings, unfrozen raw');
  assert.throws(() => UI.html.apply(null, [withRaw, 1, 2, 3]), TypeError, 'wrong arity: too many');
  assert.throws(() => UI.html.apply(null, [withRaw, 1]), TypeError, 'wrong arity: too few');
  assert.throws(() => UI.html(...[withRaw, 1]), TypeError, 'spread call with wrong arity');
  assert.throws(() => UI.html(), TypeError);
  assert.doesNotThrow(() => UI.html.apply(null, [withRaw, 1, 2]), 'a well-formed call shape passes');
});

// ---- url ----
test('url blocks dangerous schemes and protocol-relative URLs', () => {
  const bad = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
    '\x01javascript:alert(1)', '\x00\x1fjavascript:alert(1)', ' \x08 javascript:alert(1)',
    'data:text/html,<script>1</script>', 'vbscript:msgbox(1)', '//evil.com', '\\\\evil.com', '/\\evil.com', null, undefined,
  ];
  for (const u of bad) assert.strictEqual(UI.url(u), '#', JSON.stringify(u));
});

test('url allows relative, query, fragment, http and https unchanged', () => {
  for (const u of ['/room/abc', 'room/abc', '?q=1', '#f', './x', '../y', 'http://a.example/p?q=1', 'https://a.example/', 'HTTPS://A.EXAMPLE/']) {
    assert.strictEqual(UI.url(u), u);
  }
});

test('url blocks entity-looking schemes', () => {
  for (const u of ['javascript&colon;alert(1)', 'jav&#x61;script:x', 'java&Tab;script:x', 'x&y']) {
    assert.strictEqual(UI.url(u), '#', u);
  }
  for (const u of ['/a?b=1&c=2', '?a=1&b=2', '#a&b', 'http://a.example/?a=1&b=2']) assert.strictEqual(UI.url(u), u, u);
});

// ---- DOM stubs ----
function fakeDom() {
  const state = { created: [], innerHTMLWrites: [], attrCalls: [], stored: {} };
  function el(tag) {
    const e = {
      tag, localName: tag, children: [], className: '', textContent: '', attrs: {}, parentNode: null,
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    };
    Object.defineProperty(e, 'innerHTML', {
      get() { return ''; },
      set(v) { state.innerHTMLWrites.push(v); },
    });
    state.created.push(e);
    return e;
  }
  state.document = {
    readyState: 'complete',
    createElement: el,
    body: el('body'),
    addEventListener() {},
    getElementById() { return null; },
    documentElement: {
      setAttribute(k, v) { state.attrCalls.push(['set', k, v]); },
      removeAttribute(k) { state.attrCalls.push(['remove', k]); },
    },
  };
  state.window = {};
  state.localStorage = {
    getItem(k) { return k in state.stored ? state.stored[k] : null; },
    setItem(k, v) { state.stored[k] = String(v); },
  };
  return state;
}

// Install the globals, load ui.js with a window present, run fn (sync or async), always clean up.
async function withDom(state, fn) {
  const names = ['document', 'window', 'localStorage', 'setTimeout'];
  const saved = {};
  for (const n of names) saved[n] = Object.getOwnPropertyDescriptor(globalThis, n);
  globalThis.document = state.document;
  globalThis.window = state.window;
  globalThis.localStorage = state.localStorage;
  globalThis.setTimeout = () => 0; // toast timers would keep the process alive
  try {
    const exported = freshRequire();
    return await fn(globalThis.window.UI, exported);
  } finally {
    for (const n of names) {
      if (saved[n]) Object.defineProperty(globalThis, n, saved[n]);
      else delete globalThis[n];
    }
    delete require.cache[require.resolve(UI_JS)];
  }
}

test('with a window, ui.js sets window.UI and not module.exports', async () => {
  await withDom(fakeDom(), (winUI, exported) => {
    assert.ok(winUI && typeof winUI.html === 'function');
    assert.deepStrictEqual(exported, {}, 'module.exports must stay untouched when window exists');
  });
  assert.strictEqual(typeof globalThis.window, 'undefined');
  assert.strictEqual(typeof globalThis.document, 'undefined');
});

test('toast sets textContent only: no innerHTML, no element made from the message', async () => {
  const state = fakeDom();
  await withDom(state, (winUI) => {
    const before = state.created.length;
    const msg = '<img src=x onerror=alert(1)>';
    const el = winUI.toast(msg);
    assert.strictEqual(el.textContent, msg);
    assert.strictEqual(el.className, 'toast toast--info');
    assert.deepStrictEqual(state.innerHTMLWrites, []);
    assert.strictEqual(state.created.length - before, 1, 'only the toast element itself may be created');
    assert.strictEqual(el.children.length, 0);
    assert.ok(!state.created.some((c) => c.tag === 'img'));
  });
});

const regionsOf = (state) => state.created.filter((c) => c.className === 'toast-region');
const toastsOf = (state) => state.created.filter((c) => /^toast toast--/.test(c.className));

test('toast region is a polite status live region, created once; danger toasts are alerts', async () => {
  const state = fakeDom();
  await withDom(state, (winUI) => {
    assert.strictEqual(regionsOf(state).length, 1);
    const region = regionsOf(state)[0];
    assert.strictEqual(region.attrs.role, 'status');
    assert.strictEqual(region.attrs['aria-live'], 'polite');
    assert.ok(!state.created.some((c) => c.className === 'sr-only'), 'the live region is the only status element');
    assert.strictEqual(winUI.toast('bad', 'danger').attrs.role, 'alert');
    assert.strictEqual(winUI.toast('fine', 'ok').attrs.role, undefined);
    winUI.toast('again');
    assert.strictEqual(regionsOf(state).length, 1);
    assert.strictEqual(region.children.length, 3);
  });
});

test('toast and copy do not throw when there is no body yet', async () => {
  const state = fakeDom();
  state.document.body = null;
  state.document.readyState = 'loading';
  await withNavigator({}, () => withDom(state, async (winUI) => {
    assert.strictEqual(winUI.toast('x'), null);
    await winUI.copy('x');
  }));
});

test('toast works before DOMContentLoaded when the body already exists', async () => {
  const state = fakeDom();
  state.document.readyState = 'loading';
  await withDom(state, (winUI) => {
    assert.strictEqual(regionsOf(state).length, 0);
    assert.ok(winUI.toast('early'));
    assert.strictEqual(regionsOf(state).length, 1);
  });
});

// ---- render ----
test('render throws for a plain string and for forged objects', async () => {
  const state = fakeDom();
  await withDom(state, (winUI) => {
    const target = state.document.createElement('div');
    const Ctor = winUI.html`x`.constructor;
    for (const bad of ['<b>x</b>', { __html: '<b>x</b>' }, { toString() { return '<b>'; } }, new Ctor(), null, undefined]) {
      assert.throws(() => winUI.render(target, bad), TypeError);
    }
    assert.deepStrictEqual(state.innerHTMLWrites, []);
  });
});

test('render throws for a script or style element, and writes nothing', async () => {
  const state = fakeDom();
  await withDom(state, (winUI) => {
    for (const tag of ['script', 'style']) {
      assert.throws(() => winUI.render(state.document.createElement(tag), winUI.html`x`), TypeError, tag);
    }
    assert.throws(() => winUI.render({ tagName: 'SCRIPT' }, winUI.html`x`), TypeError, 'tagName fallback');
    assert.deepStrictEqual(state.innerHTMLWrites, []);
  });
});

test('render sets innerHTML for real SafeHtml, with interpolations escaped', async () => {
  const state = fakeDom();
  await withDom(state, (winUI) => {
    winUI.render(state.document.createElement('div'), winUI.html`<p>${'<b>'}</p>`);
    assert.deepStrictEqual(state.innerHTMLWrites, ['<p>&lt;b&gt;</p>']);
  });
});

// ---- copy ----
async function withNavigator(nav, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  try { return await fn(); } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
}

test('copy shows an ok toast on success', async () => {
  const state = fakeDom();
  let written = null;
  const nav = { clipboard: { writeText(t) { written = t; return Promise.resolve(); } } };
  await withNavigator(nav, () => withDom(state, async (winUI) => {
    await winUI.copy('hello');
    assert.strictEqual(written, 'hello');
    assert.deepStrictEqual(toastsOf(state).map((t) => [t.className, t.textContent]), [['toast toast--ok', 'Copied']]);
  }));
});

test('copy shows an info toast on failure and when there is no clipboard', async () => {
  const failing = { clipboard: { writeText() { return Promise.reject(new Error('denied')); } } };
  for (const nav of [failing, {}]) {
    const state = fakeDom();
    await withNavigator(nav, () => withDom(state, async (winUI) => {
      await winUI.copy('hello');
      assert.deepStrictEqual(toastsOf(state).map((t) => [t.className, t.textContent]), [['toast toast--info', 'Press Ctrl+C to copy']]);
    }));
  }
});

test('toast allowlists kind', async () => {
  await withDom(fakeDom(), (winUI) => {
    for (const k of ['info', 'ok', 'warn', 'danger']) assert.strictEqual(winUI.toast('m', k).className, 'toast toast--' + k);
    for (const k of ['nope', '"><x']) assert.strictEqual(winUI.toast('m', k).className, 'toast toast--info', k);
  });
});

test('setTheme / getTheme allowlist', async () => {
  const state = fakeDom();
  await withDom(state, (winUI) => {
    winUI.setTheme('evil');
    assert.strictEqual(state.stored['ui-theme'], 'system');
    assert.deepStrictEqual(state.attrCalls.pop(), ['remove', 'data-theme']);
    winUI.setTheme('dark');
    assert.deepStrictEqual(state.attrCalls.pop(), ['set', 'data-theme', 'dark']);
    assert.strictEqual(state.stored['ui-theme'], 'dark');
    winUI.setTheme('light');
    assert.deepStrictEqual(state.attrCalls.pop(), ['set', 'data-theme', 'light']);
    state.stored['ui-theme'] = '<garbage>';
    assert.strictEqual(winUI.getTheme(), 'system');
    state.stored['ui-theme'] = 'dark';
    assert.strictEqual(winUI.getTheme(), 'dark');
  });
});

test('a throwing localStorage does not throw', async () => {
  const state = fakeDom();
  state.localStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  await withDom(state, (winUI) => {
    assert.strictEqual(winUI.getTheme(), 'system');
    assert.doesNotThrow(() => winUI.setTheme('dark'));
    assert.deepStrictEqual(state.attrCalls.pop(), ['set', 'data-theme', 'dark']);
  });
});

// ---- theme.js ----
function runTheme(stored, throws) {
  const calls = [];
  const ctx = vm.createContext({
    // key-aware: only the real theme key returns the stored value
    localStorage: { getItem(k) { if (throws) throw new Error('denied'); return k === 'ui-theme' ? stored : null; } },
    document: { documentElement: { setAttribute(k, v) { calls.push([k, v]); } } },
  });
  vm.runInContext(fs.readFileSync(THEME_JS, 'utf8'), ctx);
  return calls;
}

test('theme.js applies a stored dark or light theme', () => {
  assert.deepStrictEqual(runTheme('dark'), [['data-theme', 'dark']]);
  assert.deepStrictEqual(runTheme('light'), [['data-theme', 'light']]);
});

test('theme.js ignores system, garbage, null and a throwing store', () => {
  assert.deepStrictEqual(runTheme('<x>'), []);
  assert.deepStrictEqual(runTheme('system'), []);
  assert.deepStrictEqual(runTheme(null), []);
  assert.deepStrictEqual(runTheme('dark', true), []);
});

test('theme.js and ui.js use the same storage key', () => {
  const ui = /THEME_KEY\s*=\s*['"]([^'"]+)['"]/.exec(fs.readFileSync(UI_JS, 'utf8'));
  const theme = /getItem\(\s*['"]([^'"]+)['"]\s*\)/.exec(fs.readFileSync(THEME_JS, 'utf8'));
  assert.ok(ui, 'THEME_KEY literal not found in ui.js');
  assert.ok(theme, 'getItem key literal not found in theme.js');
  assert.strictEqual(theme[1], ui[1]);
});
