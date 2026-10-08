'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { UI_JS, THEME_JS, UI_DIR, UI_CSS } = require('../test-support/paths');

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

test('API surface is exactly alertBox,announce,byId,callout,copy,copyField,describedBy,disableAll,esc,fieldError,getTheme,html,icon,loadConfig,render,request,setBusy,setTheme,toast,url', () => {
  assert.deepStrictEqual(Object.keys(UI).sort(), 'alertBox,announce,byId,callout,copy,copyField,describedBy,disableAll,esc,fieldError,getTheme,html,icon,loadConfig,render,request,setBusy,setTheme,toast,url'.split(',').sort());
  assert.deepStrictEqual(Object.keys(UI.describedBy).sort(), ['add', 'remove']);
  assert.strictEqual(UI.raw, undefined);
});

// ---- icon ----
const ICON_NAMES = ['lock', 'lock-sm', 'check', 'alert', 'info', 'link', 'copy', 'warn', 'github'];

test('icon: every known name is trusted SVG markup, decorative and sized by the icon classes', () => {
  for (const name of ICON_NAMES) {
    const out = UI.icon(name);
    const s = String(out);
    assert.ok(s.startsWith('<svg class="icon') && s.endsWith('</svg>'), name);
    assert.ok(s.includes('aria-hidden="true"'), name);
    assert.strictEqual(String(UI.html`<i>${out}</i>`), `<i>${s}</i>`, 'passes through html unescaped: ' + name);
  }
  assert.ok(String(UI.icon('lock-sm')).includes('icon--sm') && !String(UI.icon('lock')).includes('icon--sm'));
  assert.notStrictEqual(String(UI.icon('alert')), String(UI.icon('warn')));
  assert.strictEqual(new Set(ICON_NAMES.map((n) => String(UI.icon(n)))).size, ICON_NAMES.length, 'each name draws something different');
});

test('icon: an unknown name gives empty markup, never the name', () => {
  for (const bad of ['', 'nope', '<script>', 'LOCK', null, undefined, 42, {}, ['lock'], '__proto__', 'constructor']) {
    assert.strictEqual(String(UI.icon(bad)), '', String(bad));
  }
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
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      classes: new Set(), hidden: false, wrap: null,
      classList: { add(c) { e.classes.add(c); }, remove(c) { e.classes.delete(c); } },
      closest(sel) { return sel === '.field' ? this.wrap : null; },
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
    const announcers = state.created.filter((c) => c.className === 'sr-only');
    assert.strictEqual(announcers.length, 1, 'one silent announcer, made at setup');
    assert.strictEqual(announcers[0].attrs.role, 'status');
    assert.strictEqual(announcers[0].attrs['aria-live'], 'polite');
    assert.strictEqual(announcers[0].parentNode, state.document.body, 'outside the toast region, so it never shows');
    assert.strictEqual(winUI.toast('bad', 'danger').attrs.role, 'alert');
    assert.strictEqual(winUI.toast('fine', 'ok').attrs.role, undefined);
    winUI.toast('again');
    assert.strictEqual(regionsOf(state).length, 1);
    assert.strictEqual(region.children.length, 3);
    winUI.announce('hello');
    assert.strictEqual(state.created.filter((c) => c.className === 'sr-only').length, 1, 'announce reuses the one announcer');
  });
});

test('toast shows at most three at once and drops the oldest first', async () => {
  const state = fakeDom();
  await withDom(state, (winUI) => {
    const region = regionsOf(state)[0];
    const made = ['one', 'two', 'three', 'four', 'five'].map((m) => winUI.toast(m));
    assert.deepStrictEqual(region.children.map((c) => c.textContent), ['three', 'four', 'five']);
    assert.strictEqual(made[0].parentNode, null, 'the oldest was removed from the page');
    assert.strictEqual(made[4].parentNode, region);
  });
});

test('toast eviction keeps a danger toast while any other kind can go instead', async () => {
  const state = fakeDom();
  await withDom(state, (winUI) => {
    const region = regionsOf(state)[0];
    const alert = winUI.toast('stay', 'danger');
    ['one', 'two', 'three', 'four'].forEach((m) => winUI.toast(m));
    assert.deepStrictEqual(region.children.map((c) => c.textContent), ['stay', 'three', 'four'], 'the oldest non-danger toasts went');
    assert.strictEqual(alert.parentNode, region);
    // two dangers and a stream of others: both dangers stay
    const second = winUI.toast('stay too', 'danger');
    winUI.toast('five');
    assert.deepStrictEqual(region.children.map((c) => c.textContent), ['stay', 'stay too', 'five']);
    assert.strictEqual(second.parentNode, region);
  });
});

test('toast eviction: when every toast is danger the oldest goes', async () => {
  const state = fakeDom();
  await withDom(state, (winUI) => {
    const region = regionsOf(state)[0];
    ['a', 'b', 'c', 'd'].forEach((m) => winUI.toast(m, 'danger'));
    assert.deepStrictEqual(region.children.map((c) => c.textContent), ['b', 'c', 'd']);
  });
});

test('announce: silent, polite, cleared then set, text only, last call wins', async () => {
  const state = fakeDom();
  await withDom(state, (winUI) => {
    const timers = [];
    const cleared = [];
    const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    globalThis.clearTimeout = (id) => { cleared.push(id); };
    try {
      const region = regionsOf(state)[0];
      const announcer = state.created.find((c) => c.className === 'sr-only');
      const toastsBefore = toastsOf(state).length;
      winUI.announce('<b>Kwame answered</b>');
      assert.strictEqual(announcer.textContent, '', 'emptied first, so a repeated sentence is read again');
      assert.strictEqual(timers.length, 1);
      timers[0]();
      assert.strictEqual(announcer.textContent, '<b>Kwame answered</b>', 'set as text, never markup');
      assert.deepStrictEqual(state.innerHTMLWrites, []);
      winUI.announce('Kwame answered');
      assert.strictEqual(announcer.textContent, '');
      winUI.announce('2 new messages');
      assert.strictEqual(cleared[cleared.length - 1], 2, 'the pending set from the earlier call is cancelled');
      timers[2]();
      assert.strictEqual(announcer.textContent, '2 new messages');
      assert.strictEqual(toastsOf(state).length, toastsBefore, 'nothing visible is ever made');
      assert.strictEqual(region.children.length, 0);
      winUI.announce(null);
      timers[3]();
      assert.strictEqual(announcer.textContent, '');
    } finally {
      globalThis.setTimeout = saved.setTimeout;
      globalThis.clearTimeout = saved.clearTimeout;
    }
  });
});

test('announce does nothing without a body', async () => {
  const state = fakeDom();
  state.document.body = null;
  state.document.readyState = 'loading';
  await withDom(state, (winUI) => {
    assert.doesNotThrow(() => winUI.announce('x'));
    assert.strictEqual(state.created.filter((c) => c.className === 'sr-only').length, 0);
  });
});

test('describedBy.add and remove edit one token and leave the rest alone', async () => {
  await withDom(fakeDom(), (winUI) => {
    const input = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; } };
    winUI.describedBy.add(input, 'hint');
    assert.strictEqual(input.attrs['aria-describedby'], 'hint');
    winUI.describedBy.add(input, 'err');
    winUI.describedBy.add(input, 'err');
    assert.strictEqual(input.attrs['aria-describedby'], 'hint err', 'no duplicate token');
    winUI.describedBy.remove(input, 'hint');
    assert.strictEqual(input.attrs['aria-describedby'], 'err');
    winUI.describedBy.remove(input, 'nope');
    assert.strictEqual(input.attrs['aria-describedby'], 'err');
    winUI.describedBy.remove(input, 'err');
    assert.ok(!('aria-describedby' in input.attrs), 'the attribute goes when the last token does');
    input.attrs['aria-describedby'] = '  a   b\n c ';
    winUI.describedBy.add(input, 'd');
    assert.strictEqual(input.attrs['aria-describedby'], 'a b c d');
    winUI.describedBy.remove(input, 'b');
    assert.strictEqual(input.attrs['aria-describedby'], 'a c d');
  });
});

test('fieldError sets and clears the message, aria-invalid, the describedby token and the .field--error look', async () => {
  const state = fakeDom();
  await withDom(state, (winUI) => {
    const mk = (id) => { const e = state.document.createElement('div'); e.id = id; return e; };
    const wrap = mk('w');
    const input = mk('name');
    input.wrap = wrap;
    input.attrs['aria-describedby'] = 'name-hint';
    const err = mk('name-error');
    err.hidden = true;
    winUI.fieldError(input, err, 'Enter your name.');
    assert.strictEqual(err.textContent, 'Enter your name.');
    assert.strictEqual(err.hidden, false);
    assert.ok(wrap.classes.has('field--error'));
    assert.strictEqual(input.attrs['aria-invalid'], 'true');
    assert.strictEqual(input.attrs['aria-describedby'], 'name-hint name-error');
    winUI.fieldError(input, err, 'Again.');
    assert.strictEqual(input.attrs['aria-describedby'], 'name-hint name-error', 'no duplicate token');
    for (const none of [null, '', undefined]) {
      winUI.fieldError(input, err, 'Enter your name.');
      winUI.fieldError(input, err, none);
      assert.strictEqual(err.textContent, '');
      assert.strictEqual(err.hidden, true);
      assert.ok(!wrap.classes.has('field--error'));
      assert.ok(!('aria-invalid' in input.attrs));
      assert.strictEqual(input.attrs['aria-describedby'], 'name-hint', 'the other token stays');
    }
    assert.deepStrictEqual(state.innerHTMLWrites, [], 'the message is text');
    // an input outside a .field still works
    const loose = mk('x');
    const looseErr = mk('x-error');
    assert.doesNotThrow(() => { winUI.fieldError(loose, looseErr, 'Bad.'); winUI.fieldError(loose, looseErr, null); });
  });
});

test('alertBox: a role=alert callout with the icon, the message escaped, the kind allowlisted', async () => {
  await withDom(fakeDom(), (winUI) => {
    const icons = { info: 'info', warn: 'warn', danger: 'warn' };
    for (const [kind, name] of Object.entries(icons)) {
      const out = String(winUI.alertBox('Went wrong', kind));
      const want = '<div class="callout callout--' + kind + '" role="alert">' + String(winUI.icon(name)) + '<div class="callout__body"><p>Went wrong</p></div></div>';
      assert.strictEqual(out, want, kind);
    }
    // anything else throws, and nothing gets as far as the markup: "ok" is not an alert kind
    for (const bad of ['ok', 'nope', '"><x', undefined, null, 'INFO', '__proto__', 'constructor', 5, {}, ['info']]) {
      assert.throws(() => winUI.alertBox('m', bad), TypeError, String(bad));
    }
    const hostile = String(winUI.alertBox('<img src=x onerror=alert(1)>', 'danger'));
    assert.ok(hostile.includes('&lt;img src=x onerror=alert(1)&gt;') && !hostile.includes('<img'));
    const inner = winUI.html`<section>${winUI.alertBox('Fine', 'info')}</section>`;
    assert.ok(String(inner).includes('role="alert"'), 'it is trusted markup and passes through html unescaped');
  });
});

test('callout: a plain callout with the kind\'s icon, a named icon, the body as given, the kind allowlisted', async () => {
  await withDom(fakeDom(), (winUI) => {
    const body = winUI.html`<p>Fine <b>${'<x>'}</b></p>`;
    const icons = { info: 'info', ok: 'check', warn: 'warn', danger: 'warn' };
    for (const [kind, name] of Object.entries(icons)) {
      const want = '<div class="callout callout--' + kind + '">' + String(winUI.icon(name)) + '<div class="callout__body"><p>Fine <b>&lt;x&gt;</b></p></div></div>';
      assert.strictEqual(String(winUI.callout(kind, body)), want, kind);
      assert.ok(!String(winUI.callout(kind, body)).includes('role='), 'not announced: ' + kind);
    }
    assert.strictEqual(String(winUI.callout('info', body, { icon: 'lock' })), '<div class="callout callout--info">' + String(winUI.icon('lock')) + '<div class="callout__body"><p>Fine <b>&lt;x&gt;</b></p></div></div>');
    assert.ok(String(winUI.callout('warn', body, { icon: 'nope' })).includes('<div class="callout__body">'), 'an unknown icon is empty, never the name');
    assert.ok(!String(winUI.callout('warn', body, { icon: '<script>' })).includes('<script>'));
    assert.ok(String(winUI.callout('warn', body, {})).includes(String(winUI.icon('warn'))));
    for (const bad of ['nope', '"><x', undefined, null, 'INFO', '__proto__']) assert.throws(() => winUI.callout(bad, body), TypeError, String(bad));
    // the body is escaped like any other value when it is not markup
    assert.ok(String(winUI.callout('info', '<img src=x>')).includes('&lt;img src=x&gt;'));
  });
});

test('alertBox and callout draw the same markup, the alert one with role="alert"', async () => {
  await withDom(fakeDom(), (winUI) => {
    for (const kind of ['info', 'warn', 'danger']) {
      const alert = String(winUI.alertBox('M', kind));
      const plain = String(winUI.callout(kind, winUI.html`<p>M</p>`));
      assert.strictEqual(alert.replace(' role="alert"', ''), plain, kind);
    }
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

// ---- request and loadConfig ----
// Runs fn with globalThis.fetch replaced by a stub that records its calls.
async function withFetch(stub, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const calls = [];
  Object.defineProperty(globalThis, 'fetch', { value: (...a) => { calls.push(a); return stub(...a); }, configurable: true, writable: true });
  try { return await fn(calls); } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
    else delete globalThis.fetch;
  }
}
const reply = (status, body, jsonFails) => () => Promise.resolve({
  ok: status >= 200 && status < 300, status,
  json: () => (jsonFails ? Promise.reject(new SyntaxError('bad json')) : Promise.resolve(body)),
});

test('request: resolves {ok, status, data} and sends a JSON body only when it is given', async () => {
  await withFetch(reply(201, { id: 'x' }), async (calls) => {
    assert.deepStrictEqual(await UI.request('POST', '/api/rooms', { topic: 't' }), { ok: true, status: 201, data: { id: 'x' } });
    assert.deepStrictEqual(calls[0], ['/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"topic":"t"}' }]);
    await UI.request('POST', '/api/demo', {});
    assert.strictEqual(calls[1][1].body, '{}', 'an empty object is still a body');
    await UI.request('GET', '/api/rooms/x');
    assert.deepStrictEqual(calls[2], ['/api/rooms/x', { method: 'GET' }], 'a GET has no headers and no body');
  });
});

test('request: a call with no body stays bare (no headers), and an empty object body is sent as JSON', async () => {
  await withFetch(reply(204, null, true), async (calls) => {
    await UI.request('POST', '/x');
    assert.deepStrictEqual(calls[0], ['/x', { method: 'POST' }], 'no body, no content type: callers that need one pass {}');
    await UI.request('POST', '/auth/logout', {});
    assert.deepStrictEqual(calls[1][1], { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  });
});

test('request: an error status still resolves, with whatever the body said', async () => {
  await withFetch(reply(403, { error: 'no' }), async () => {
    assert.deepStrictEqual(await UI.request('POST', '/x', {}), { ok: false, status: 403, data: { error: 'no' } });
  });
});

test('request: a body that is not JSON gives data = {}, and a JSON null does too', async () => {
  await withFetch(reply(500, null, true), async () => {
    assert.deepStrictEqual(await UI.request('GET', '/x'), { ok: false, status: 500, data: {} });
  });
  await withFetch(reply(200, null), async () => {
    assert.deepStrictEqual(await UI.request('GET', '/x'), { ok: true, status: 200, data: {} });
  });
});

test('request: a network failure is status 0 and never rejects, even when fetch throws at once', async () => {
  await withFetch(() => Promise.reject(new TypeError('network')), async () => {
    assert.deepStrictEqual(await UI.request('GET', '/x'), { ok: false, status: 0, data: {} });
  });
  await withFetch(() => { throw new Error('sync'); }, async () => {
    assert.deepStrictEqual(await UI.request('POST', '/x', {}), { ok: false, status: 0, data: {} });
  });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  delete globalThis.fetch;
  try { assert.deepStrictEqual(await UI.request('GET', '/x'), { ok: false, status: 0, data: {} }, 'no fetch at all'); } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
  }
});

test('loadConfig: {live, passcode, signin} from /api/config, asked once however often it is called', async () => {
  const U = freshRequire();
  await withFetch(reply(200, { live: true, passcode: 'secret', maxTurns: 12, mcpUrl: 'x' }), async (calls) => {
    const a = U.loadConfig();
    const b = U.loadConfig();
    assert.strictEqual(a, b, 'the same promise');
    assert.deepStrictEqual(await a, { live: true, passcode: true, signin: 'off', invite: false });
    assert.deepStrictEqual(await U.loadConfig(), { live: true, passcode: true, signin: 'off', invite: false });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], ['/api/config', { method: 'GET' }]);
  });
});

test('loadConfig: signin is "github" only when the server says exactly that, and "off" for anything else', async () => {
  for (const [sent, want] of [['github', 'github'], ['off', 'off'], [undefined, 'off'], [null, 'off'], [true, 'off'], ['GitHub', 'off'], [{}, 'off'], ['github ', 'off']]) {
    const U = freshRequire();
    await withFetch(reply(200, { live: true, passcode: false, signin: sent }), async () => {
      assert.deepStrictEqual(await U.loadConfig(), { live: true, passcode: false, signin: want, invite: false }, String(sent));
    });
  }
});

test('loadConfig: invite is true only when the server says exactly true', async () => {
  for (const [sent, want] of [[true, true], [false, false], [undefined, false], [null, false], ['true', false], [1, false], [{}, false]]) {
    const U = freshRequire();
    await withFetch(reply(200, { live: true, passcode: false, signin: 'github', invite: sent }), async () => {
      assert.deepStrictEqual(await U.loadConfig(), { live: true, passcode: false, signin: 'github', invite: want }, String(sent));
    });
  }
});

test('loadConfig: a failed read is null and is not remembered, so the next call tries again', async () => {
  const U = freshRequire();
  let n = 0;
  const flaky = () => (++n === 1 ? Promise.reject(new Error('down')) : reply(200, { live: false, passcode: false })());
  await withFetch(flaky, async (calls) => {
    assert.strictEqual(await U.loadConfig(), null);
    assert.deepStrictEqual(await U.loadConfig(), { live: false, passcode: false, signin: 'off', invite: false });
    assert.deepStrictEqual(await U.loadConfig(), { live: false, passcode: false, signin: 'off', invite: false });
    assert.strictEqual(calls.length, 2, 'one failure, one success, then remembered');
  });
});

test('loadConfig: an error status, a body that is not JSON and a body without "live" are all null', async () => {
  for (const stub of [reply(500, { live: true }), reply(200, null, true), reply(200, {}), reply(200, { live: 'yes' }), reply(200, [])]) {
    const U = freshRequire();
    await withFetch(stub, async () => assert.strictEqual(await U.loadConfig(), null));
  }
});

// ---- setBusy, disableAll, byId ----
function control(tag) {
  return {
    localName: tag, attrs: {}, disabled: false,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
  };
}

test('setBusy: aria-busy on any element, disabled too on form controls, one element or a list, and off again', () => {
  const button = control('button');
  const region = control('div');
  UI.setBusy(button, true);
  assert.deepStrictEqual([button.attrs['aria-busy'], button.disabled], ['true', true]);
  UI.setBusy(button, false);
  assert.deepStrictEqual([button.attrs['aria-busy'], button.disabled], [undefined, false]);
  UI.setBusy(region, true);
  assert.deepStrictEqual([region.attrs['aria-busy'], region.disabled], ['true', false], 'a region is busy but not disabled');
  UI.setBusy(region, false);
  assert.ok(!('aria-busy' in region.attrs));
  const list = ['button', 'input', 'select', 'textarea', 'a'].map(control);
  UI.setBusy(list, true);
  assert.deepStrictEqual(list.map((e) => [e.attrs['aria-busy'], e.disabled]), [['true', true], ['true', true], ['true', true], ['true', true], ['true', false]]);
  UI.setBusy(list, false);
  assert.ok(list.every((e) => !e.disabled && !('aria-busy' in e.attrs)));
  assert.doesNotThrow(() => UI.setBusy(null, true));
  assert.doesNotThrow(() => UI.setBusy([null, button], true));
  assert.strictEqual(button.disabled, true);
  UI.setBusy(button, 0);
  assert.strictEqual(button.disabled, false, 'a falsy flag turns it off');
});

test('disableAll: every control under the root, including a fieldset, and nothing else', () => {
  const kids = ['button', 'input', 'select', 'textarea', 'fieldset', 'a'].map(control);
  const asked = [];
  const root = { querySelectorAll(sel) { asked.push(sel); return kids.filter((k) => sel.split(', ').includes(k.localName)); } };
  UI.disableAll(root);
  assert.deepStrictEqual(kids.map((k) => k.disabled), [true, true, true, true, true, false]);
  assert.strictEqual(asked.length, 1);
});

test('byId is document.getElementById', async () => {
  const state = fakeDom();
  const found = {};
  state.document.getElementById = (id) => (id === 'x' ? found : null);
  await withDom(state, (winUI) => {
    assert.strictEqual(winUI.byId('x'), found);
    assert.strictEqual(winUI.byId('nope'), null);
  });
});

// ---- copyField ----
test('copyField: a labelled readonly input and a Copy button, with the value never in the markup', () => {
  const SECRET = 'https://x.test/room/abc?seat=B&t=SENTINEL-TOKEN';
  const f = UI.copyField({ id: 'invite-link', label: "Kwame's link", note: "You can't get this back.", value: SECRET });
  const out = String(f.html);
  assert.ok(!out.includes('SENTINEL-TOKEN') && !out.includes('value='), 'no value in the markup');
  assert.ok(out.includes('<label class="field__label" for="invite-link">Kwame&#39;s link</label>'));
  assert.ok(out.includes('<span class="field__hint" id="invite-link-hint">You can&#39;t get this back.</span>'));
  assert.ok(out.includes('<input class="input" id="invite-link" type="text" readonly aria-describedby="invite-link-hint">'));
  assert.ok(out.includes('<button class="btn btn--secondary" type="button" data-copy="invite-link">' + String(UI.icon('copy')) + 'Copy link</button>'));
  assert.ok(out.startsWith('<div class="field">') && out.includes('<div class="copy-field">'));
  // the button text can be changed, and is escaped
  assert.ok(String(UI.copyField({ id: 'a', label: 'L', note: 'N', button: '<b>Copy</b>' }).html).includes('&lt;b&gt;Copy&lt;/b&gt;</button>'));
});

test('copyField: the markup passes through UI.html as markup (interpolate .html, not the object)', () => {
  const f = UI.copyField({ id: 'a', label: 'L', note: 'N' });
  assert.ok(String(UI.html`<div>${f.html}</div>`).startsWith('<div><div class="field">'));
  assert.ok(String(UI.html`<div>${f}</div>`).includes('[object Object]'), 'the wrapper itself is not markup');
});

test('copyField: markup values are escaped, and nothing hostile reaches an attribute', () => {
  const out = String(UI.copyField({ id: 'a"><script>', label: '<img src=x onerror=1>', note: '<i>' }).html);
  assert.ok(!out.includes('<script>') && !out.includes('<img') && !out.includes('<i>'));
});

test('copyField.fill sets the value as a property on the input with that id, and only that one', () => {
  const mk = (id) => ({ id, value: '' });
  const inputs = [mk('other'), mk('invite-link'), mk('own-link')];
  const root = { querySelectorAll(sel) { assert.strictEqual(sel, 'input'); return inputs; } };
  UI.copyField({ id: 'invite-link', label: 'L', note: 'N', value: 'https://x.test/a' }).fill(root);
  UI.copyField({ id: 'own-link', label: 'L', note: 'N', value: 12 }).fill(root);
  assert.deepStrictEqual(inputs.map((i) => i.value), ['', 'https://x.test/a', '12']);
  // no value given: nothing is touched
  const before = mk('x');
  UI.copyField({ id: 'x', label: 'L', note: 'N' }).fill({ querySelectorAll: () => [before] });
  assert.strictEqual(before.value, '');
  assert.doesNotThrow(() => UI.copyField({ id: 'x', value: 'v' }).fill(null));
});

// ---- header height ----
test('the header height is measured once at setup, only when there is a header with a height', async () => {
  const measured = [];
  const withHeader = (offsetHeight) => {
    const state = fakeDom();
    state.document.querySelector = (sel) => (sel === '.site-header' ? { offsetHeight } : null);
    state.document.documentElement.style = { setProperty(k, v) { measured.push([k, v]); } };
    return state;
  };
  await withDom(withHeader(97), (winUI) => {
    winUI.toast('x');
    winUI.toast('y');
  });
  assert.deepStrictEqual(measured, [['--header-h', '97px']], 'set once, with the measured height');
  measured.length = 0;
  await withDom(withHeader(0), () => {});
  assert.deepStrictEqual(measured, [], 'a header with no height keeps the token');
  // no header, no querySelector and no style are all fine: the fake DOM of the other tests has none of them
  const none = fakeDom();
  none.document.querySelector = () => null;
  none.document.documentElement.style = { setProperty() { measured.push('bad'); } };
  await withDom(none, () => {});
  await withDom(fakeDom(), (winUI) => assert.ok(winUI.toast('ok')));
  assert.deepStrictEqual(measured, []);
});

test('ui.css keeps --header-h as the 64px fallback and the header itself never reads it', () => {
  const css = fs.readFileSync(UI_CSS, 'utf8');
  assert.match(css, /--header-h:\s*64px/);
  assert.match(css, /\.site-header__inner\s*\{[^}]*min-height:\s*var\(--header-min\)/, 'measuring --header-h can not make the header taller');
  assert.match(css, /--header-min:\s*64px/);
});

// ---- the guide's alertBox snippet ----
test('the guide\'s alertBox snippet is exactly what UI.alertBox returns', () => {
  const guide = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  const m = /data-snippet="callout-alert">([\s\S]*?)<\/div>\s*<\/div>\s*<details/.exec(guide);
  assert.ok(m, 'the callout-alert example is in the guide');
  const norm = (h) => h.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').replace(/> </g, '><').trim();
  const body = /<div class="callout__body"><p>([\s\S]*?)<\/p><\/div>/.exec(m[0] + '</div>');
  assert.ok(body, 'the example has a message');
  const message = body[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const kind = /callout callout--(info|warn|danger)" role="alert"/.exec(m[1]);
  assert.ok(kind, 'the example is an alert');
  assert.strictEqual(norm(m[1] + '</div>'), norm(String(UI.alertBox(message, kind[1]))));
});

test('the guide documents every helper that makes or changes markup', () => {
  const guide = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  for (const name of ['UI.alertBox', 'UI.callout', 'UI.copyField', 'UI.setBusy', 'UI.disableAll', 'UI.fieldError', 'UI.describedBy', 'UI.icon', 'UI.toast', 'UI.announce']) {
    assert.ok(guide.includes(name), name + ' has a guide entry');
  }
  assert.match(guide, /UI\.fieldError[^]*?already exists and has an <code>id<\/code>/, 'fieldError needs an element that already exists and has an id');
});
