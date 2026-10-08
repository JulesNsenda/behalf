/*
 * Behalf UI helpers. One classic script, no dependencies.
 *
 * Safe-HTML rules (UI.html templates):
 *  - Always quote attributes:  <a href="${UI.url(u)}">  never  <a href=${x}>.
 *  - Never interpolate into a style attribute, an on* handler or a <script> element.
 *  - Pass every URL through UI.url() before it goes into href or src.
 *  - Untrusted text is escaped automatically. Trusted fragments are built with UI.html
 *    itself; there is deliberately no way to turn a plain string into trusted markup.
 *  - UI.render(el, safe) is THE innerHTML sink: pages never assign innerHTML themselves.
 *    Use textContent for plain text.
 *  - Never interpolate into a tag name or an unquoted attribute position: every tag is a
 *    literal. Choose between literal templates, never build a tag name.
 *  - Never interpolate untrusted data into `id` or `name` attributes; `data-copy` resolves
 *    the first element with that id.
 *  - Values (a link, a token) never go into markup: copyField gives an empty readonly input, and the value
 *    is set as a property after render.
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

  // ---- icons ----
  // Fixed icons as trusted markup. Each case is a literal template, so a name never reaches the markup:
  // an unknown name gives empty markup. "lock-sm" is the small lock that sits inside a pill.
  function icon(name) {
    switch (name) {
      case 'lock': return html`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
      case 'lock-sm': return html`<svg class="icon icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
      case 'check': return html`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
      case 'alert': return html`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.5"/></svg>`;
      case 'info': return html`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/></svg>`;
      case 'link': return html`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`;
      case 'copy': return html`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>`;
      case 'warn': return html`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg>`;
      // The GitHub mark is a solid shape, so it is filled where the others are drawn with a stroke.
      case 'github': return html`<svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
      default: return html``;
    }
  }

  // ---- callouts ----
  // The icon each kind gets unless the caller names another.
  var CALLOUT_ICONS = { info: 'info', ok: 'check', warn: 'warn', danger: 'warn' };

  // The one place callout markup is made. The kind is checked against the allowlist before it reaches the
  // class attribute, so an unknown kind throws and never gets as far as the markup. body is trusted markup.
  function calloutOf(kind, body, iconName, alert) {
    if (KINDS.indexOf(kind) === -1) throw new TypeError('UI.callout: unknown kind');
    var glyph = icon(iconName || CALLOUT_ICONS[kind]);
    return alert
      ? html`<div class="callout callout--${kind}" role="alert">${glyph}<div class="callout__body">${body}</div></div>`
      : html`<div class="callout callout--${kind}">${glyph}<div class="callout__body">${body}</div></div>`;
  }

  // A callout: kind is info, ok, warn or danger; body is UI.html markup (usually a <p>); opts.icon names
  // another icon. Not announced: use alertBox for the failure of something the person just did.
  function callout(kind, body, opts) { return calloutOf(kind, body, opts && opts.icon, false); }

  // A callout that is announced at once, for the failure of something the person just did. The kind is
  // info, warn or danger; anything else throws.
  function alertBox(message, kind) {
    if (kind !== 'info' && kind !== 'warn' && kind !== 'danger') throw new TypeError('UI.alertBox: unknown kind');
    return calloutOf(kind, html`<p>${message}</p>`, undefined, true);
  }

  // A field with a readonly input and a Copy button, for a link or a command. Returns {html, fill}: html
  // is the markup, and fill(root) sets the value as a property on the input it finds under root, after
  // root has been rendered. The value is never part of the markup. opts: {id, label, note, value, button}
  // where note is the hint under the label and button is the button's text (default "Copy link").
  function copyField(opts) {
    opts = opts || {};
    var id = str(opts.id);
    var markup = html`<div class="field">
        <label class="field__label" for="${id}">${opts.label}</label>
        <span class="field__hint" id="${id}-hint">${opts.note}</span>
        <div class="copy-field">
          <input class="input" id="${id}" type="text" readonly aria-describedby="${id}-hint">
          <button class="btn btn--secondary" type="button" data-copy="${id}">${icon('copy')}${opts.button == null ? 'Copy link' : opts.button}</button>
        </div>
      </div>`;
    function fill(root) {
      if (opts.value == null || !root) return;
      Array.prototype.forEach.call(root.querySelectorAll('input'), function (input) {
        if (input.id === id) input.value = str(opts.value);
      });
    }
    return { html: markup, fill: fill };
  }

  // ---- requests and busy state ----
  // One fetch for every call: resolves {ok, status, data} and never rejects. A network failure is
  // status 0, and a body that isn't JSON gives data = {}. body, when given, is sent as JSON.
  function request(method, url, body) {
    var init = { method: method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return Promise.resolve().then(function () { return fetch(url, init); }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { ok: r.ok, status: r.status, data: d == null ? {} : d };
      });
    }, function () { return { ok: false, status: 0, data: {} }; });
  }

  // The server's settings as {live, passcode, signin, invite}, or null when they couldn't be read. signin is 'github'
  // when people must sign in to open a room, and 'off' otherwise (also when an older server doesn't say). invite is
  // true only when the server says exactly that: an invite can be sent by email.
  // One request per page: a good answer is kept, a failed one is not, so the next call tries again.
  var configPromise = null;
  function loadConfig() {
    if (!configPromise) {
      configPromise = request('GET', '/api/config').then(function (res) {
        if (!res.ok || typeof res.data.live !== 'boolean') { configPromise = null; return null; }
        return { live: res.data.live, passcode: Boolean(res.data.passcode), signin: res.data.signin === 'github' ? 'github' : 'off', invite: res.data.invite === true };
      });
    }
    return configPromise;
  }

  var CONTROL = /^(?:button|input|select|textarea)$/i;

  // Marks an element, or each element of an array, busy (aria-busy) or not. Form controls are also
  // disabled while busy, so they can't be used twice.
  function setBusy(target, on) {
    (Array.isArray(target) ? target : [target]).forEach(function (el) {
      if (!el) return;
      if (on) el.setAttribute('aria-busy', 'true');
      else el.removeAttribute('aria-busy');
      if (CONTROL.test(el.localName || '')) el.disabled = Boolean(on);
    });
  }

  // Disables every form control under root, for a form or a view that must stay shut.
  function disableAll(root) {
    Array.prototype.forEach.call(root.querySelectorAll('button, input, select, textarea, fieldset'), function (el) { el.disabled = true; });
  }

  function byId(id) { return document.getElementById(id); }

  // aria-describedby is a list of ids: these add or remove one token and leave the others alone.
  function tokens(el) { return str(el.getAttribute('aria-describedby')).split(/\s+/).filter(Boolean); }

  function addToken(el, id) {
    var ids = tokens(el);
    if (ids.indexOf(id) === -1) ids.push(id);
    el.setAttribute('aria-describedby', ids.join(' '));
  }

  function removeToken(el, id) {
    var ids = tokens(el).filter(function (x) { return x !== id; });
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  }

  var describedBy = { add: addToken, remove: removeToken };

  // Shows or clears a field's error: the message in errorEl, aria-invalid and the describedby token on
  // the input, and the .field--error look on the .field around it. A null or empty message clears.
  function fieldError(input, errorEl, message) {
    var wrap = input.closest ? input.closest('.field') : null;
    if (message) {
      errorEl.textContent = str(message);
      errorEl.hidden = false;
      if (wrap) wrap.classList.add('field--error');
      input.setAttribute('aria-invalid', 'true');
      if (errorEl.id) addToken(input, errorEl.id);
    } else {
      errorEl.textContent = '';
      errorEl.hidden = true;
      if (wrap) wrap.classList.remove('field--error');
      input.removeAttribute('aria-invalid');
      if (errorEl.id) removeToken(input, errorEl.id);
    }
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
  var announcer = null;
  var announceTimer = null;
  var MAX_TOASTS = 3;

  function setup() {
    if (toastRegion || !document.body) return;
    toastRegion = document.createElement('div');
    toastRegion.className = 'toast-region';
    toastRegion.setAttribute('role', 'status');
    toastRegion.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastRegion);

    // Silent: a visually hidden live region for updates that must be heard but not shown.
    announcer = document.createElement('div');
    announcer.className = 'sr-only';
    announcer.setAttribute('role', 'status');
    announcer.setAttribute('aria-live', 'polite');
    announcer.setAttribute('aria-atomic', 'true');
    document.body.appendChild(announcer);

    // Toasts sit under the site header, which can be taller than its token when its links wrap: measure it
    // once. Without a header, or before it has a height, the token's own 64px stays.
    var header = typeof document.querySelector === 'function' ? document.querySelector('.site-header') : null;
    var root = document.documentElement;
    if (header && header.offsetHeight > 0 && root && root.style) root.style.setProperty('--header-h', header.offsetHeight + 'px');

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
    // At most three show at once: the oldest goes first, but a danger toast is kept for as long as any
    // other kind is there to go instead.
    while (toastRegion.children.length > MAX_TOASTS) {
      var all = toastRegion.children;
      var gone = all[0];
      for (var i = 0; i < all.length; i++) {
        if (all[i].className.indexOf('toast--danger') === -1) { gone = all[i]; break; }
      }
      toastRegion.removeChild(gone);
    }
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4000);
    return el;
  }

  // Says a message to screen readers without showing anything. The region is emptied first and filled a
  // moment later, so the same sentence twice in a row is still read out.
  function announce(message) {
    if (!HAS_DOM || !document.body) return;
    setup();
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announceTimer = setTimeout(function () { announcer.textContent = str(message); }, 50);
  }

  var UI = {
    esc: esc, html: html, icon: icon, url: url, render: render, copy: copy, toast: toast, announce: announce,
    alertBox: alertBox, callout: callout, copyField: copyField, describedBy: describedBy, fieldError: fieldError,
    request: request, loadConfig: loadConfig, setBusy: setBusy, disableAll: disableAll, byId: byId,
    setTheme: setTheme, getTheme: getTheme
  };

  if (HAS_DOM) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
    else setup();
  }

  if (typeof window !== 'undefined') window.UI = UI;
  else if (typeof module !== 'undefined' && module.exports) module.exports = UI;
})();
