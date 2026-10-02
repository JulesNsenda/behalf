/*
 * Proxy Room UI helpers. One classic script, no dependencies.
 *
 * Safe-HTML rules (UI.html templates):
 *  - Always quote attributes:  <a href="${UI.url(u)}">  never  <a href=${x}>.
 *  - Never interpolate into a style attribute, an on* handler or a <script> element.
 *  - Pass every URL through UI.url() before it goes into href or src.
 *  - Untrusted text is escaped automatically. Trusted fragments are built with UI.html
 *    itself; there is deliberately no way to turn a plain string into trusted markup.
 *  - UI.render(el, safe) is THE innerHTML sink: pages never assign innerHTML themselves.
 *    Use textContent for plain text.
 *  - Never interpolate untrusted data into `id` or `name` attributes; `data-copy` resolves
 *    the first element with that id.
 */
(function () {
  'use strict';

  var THEME_KEY = 'ui-theme';
  var THEMES = ['light', 'dark', 'system'];
  var KINDS = ['info', 'ok', 'warn', 'danger'];

  // Set at load: a DOM exists or it doesn't for the life of the page.
  var HAS_DOM = typeof document !== 'undefined';

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function str(v) { return v == null ? '' : String(v); }

  function esc(s) {
    return str(s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  // Trusted markup lives only in this private WeakMap, keyed by objects UI.html minted.
  // A forged object, one built from .constructor, or one whose fields were changed is
  // not in the map, so it gets escaped like any other value.
  var trusted = new WeakMap();
  function SafeHtml() {}
  SafeHtml.prototype.toString = function () { return trusted.has(this) ? trusted.get(this) : ''; };
  function mint(s) { var o = new SafeHtml(); trusted.set(o, s); return Object.freeze(o); }

  function part(v) {
    if (v !== null && typeof v === 'object' && trusted.has(v)) return trusted.get(v);
    if (Array.isArray(v)) return v.map(part).join('');
    return v === false ? '' : esc(v);
  }

  function html(strings) {
    // Rejects accidental plain calls (arrays, strings, look-alike shapes from data). It is not
    // a boundary against deliberately forged first-party code; the lint in test/pages.test.js
    // flags the common forgery shapes, which is a heuristic, not a boundary. A real
    // tagged-template call has frozen strings with a frozen .raw, and one argument per template slot.
    if (!Array.isArray(strings) || !Array.isArray(strings.raw) ||
        !Object.isFrozen(strings) || !Object.isFrozen(strings.raw) ||
        strings.raw.length !== strings.length || arguments.length !== strings.length) {
      throw new TypeError('UI.html must be used as a template tag');
    }
    var out = strings[0];
    for (var i = 1; i < arguments.length; i++) out += part(arguments[i]) + strings[i];
    return mint(out);
  }

  function render(el, safe) {
    if (safe === null || typeof safe !== 'object' || !trusted.has(safe)) {
      throw new TypeError('UI.render needs the result of UI.html');
    }
    if (/^(script|style)$/i.test(el.localName || el.tagName || '')) {
      throw new TypeError('UI.render cannot target a script or style element');
    }
    el.innerHTML = trusted.get(safe);
  }

  function url(u) {
    if (u === null || u === undefined) return '#';
    var s = String(u).trim();
    // Browsers drop tabs/newlines and ignore leading control chars inside URLs, so
    // judge a probe with all of those removed, but return the caller's string unchanged.
    var probe = s.replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '');
    if (/^[\/\\]{2}/.test(probe)) return '#'; // protocol-relative
    if (/^[^\/?#]*&/.test(probe)) return '#'; // entity-looking scheme, e.g. javascript&colon;
    var m = /^([a-z][a-z0-9+.\-]*):/i.exec(probe);
    if (m) {
      var scheme = m[1].toLowerCase();
      return scheme === 'http' || scheme === 'https' ? s : '#';
    }
    return s;
  }

  // ---- theme ----
  function allow(t) { return THEMES.indexOf(t) !== -1 ? t : 'system'; }

  function getTheme() {
    try { return allow(localStorage.getItem(THEME_KEY)); } catch (e) { return 'system'; }
  }

  function setTheme(t) {
    t = allow(t);
    if (HAS_DOM) {
      if (t === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', t);
    }
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* storage unavailable */ }
  }

  // ---- DOM wiring (browser only, lazy) ----
  var toastRegion = null;

  function setup() {
    if (toastRegion || !document.body) return;
    toastRegion = document.createElement('div');
    toastRegion.className = 'toast-region';
    toastRegion.setAttribute('role', 'status');
    toastRegion.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastRegion);

    document.addEventListener('click', function (e) {
      var t = e.target;
      var el = t && t.closest ? t.closest('[data-copy]') : null;
      if (!el) return;
      var src = document.getElementById(el.getAttribute('data-copy'));
      if (!src) return;
      var text = typeof src.value === 'string' ? src.value : src.textContent;
      copy(text, src);
    });
  }

  function isMac() {
    if (typeof navigator === 'undefined') return false;
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /mac|iphone|ipad|ipod/i.test(p);
  }

  function copy(text, src) {
    text = str(text);
    var fail = function () {
      if (src && typeof src.select === 'function') {
        try { src.focus(); src.select(); } catch (e) { /* ignore */ }
      }
      toast('Press ' + (isMac() ? 'Cmd' : 'Ctrl') + '+C to copy', 'info');
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { toast('Copied', 'ok'); }, fail);
      }
    } catch (e) { /* fall through */ }
    fail();
    return Promise.resolve();
  }

  function toast(message, kind) {
    if (!HAS_DOM || !document.body) return null;
    setup();
    var k = KINDS.indexOf(kind) !== -1 ? kind : 'info';
    var el = document.createElement('div');
    el.className = 'toast toast--' + k;
    if (k === 'danger') el.setAttribute('role', 'alert');
    el.textContent = str(message);
    toastRegion.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4000);
    return el;
  }

  var UI = { esc: esc, html: html, url: url, render: render, copy: copy, toast: toast, setTheme: setTheme, getTheme: getTheme };

  if (HAS_DOM) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
    else setup();
  }

  if (typeof window !== 'undefined') window.UI = UI;
  else if (typeof module !== 'undefined' && module.exports) module.exports = UI;
})();
