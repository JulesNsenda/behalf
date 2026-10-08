'use strict';
// The one harness for running the real page scripts (web/js/account.js, connect.js, start.js, room-kit.js) in a vm against a small
// fake of the page: just enough DOM for UI.render, UI.copyField and the controls they make, with the real ui.js and the real view modules.
// Requests go through `request(method, url, body)`, which a test supplies (a script of answers, or the real ui.js over HTTP). What the
// tests look at is what a person would: the markup a container was last given, the text of the command, the toasts, which control has
// the focus, and which requests were made.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { WEB } = require('./paths');

const realUI = require('../web/ui/ui.js');
const AccountView = require('../web/js/account-view.js');
const RoomView = require('../web/js/room-view.js');
const Links = require('../web/js/links.js');

// The answers a scripted server gives, as UI.request resolves them.
const ok = (status, data) => ({ ok: true, status, data: data || {} });
const refused = (status, code) => ({ ok: false, status, data: code ? { error: 'text from the server', code } : {} });
const ME = (over) => ({ signin: 'github', user: { login: 'octocat' }, agentKeys: [], ...over });

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const plain = (html) => html.split('&#39;').join("'");

// An element. page.focused records the id of the one that was focused last.
function makeEl(page, id) {
  const listeners = {};
  const attrs = {};
  return {
    id, hidden: false, textContent: '', innerHTML: '', value: '', checked: false, disabled: false, localName: 'div',
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, event) { for (const fn of listeners[type] || []) fn(event || {}); },
    click() { this.fire('click', {}); },
    focus() { page.focused = id; },
    querySelectorAll() { return []; },
  };
}

// An element that holds rendered markup: the ids in that markup are the elements that exist, new ones after every render.
function container(page, id) {
  let html = '';
  let elems = new Map();
  const c = makeEl(page, id);
  Object.defineProperty(c, 'innerHTML', { get: () => html, set: (v) => { html = String(v); elems = new Map(); }, enumerable: true });
  c.find = (wanted) => {
    if (!html.includes(`id="${wanted}"`)) return null;
    if (!elems.has(wanted)) elems.set(wanted, makeEl(page, wanted));
    return elems.get(wanted);
  };
  c.querySelectorAll = (sel) => (sel === 'input' ? [...html.matchAll(/<input\b[^>]*\bid="([^"]+)"/g)].map((m) => c.find(m[1])) : []);
  return c;
}

// Runs the named scripts of web/js/ in order, in the context ctx.
function runScripts(ctx, names) {
  vm.createContext(ctx);
  for (const name of names) vm.runInContext(fs.readFileSync(path.join(WEB, 'js', name), 'utf8'), ctx, { filename: name });
}

// opts:
//   request   (method, url, body) -> an answer (see ok, refused), or a promise of one
//   config    what UI.loadConfig resolves (default: sign-in on), or null for settings that can't be read
//   scripts   the scripts to run (default account.js and connect.js)
//   pathname, search, hash, origin   where the page is
//   lazy      true: any id asked for is an element (the start page's form); false: only the connect page's own elements and what was rendered
//   setTimeout  stands in for the page's timer (a test that runs a deadline by hand)
//   hidden    ids of lazy elements that start hidden, as in the page's markup (the start page's form and sign-in)
function loadPage(opts) {
  const page = { focused: null, toasts: [], requests: [], replaced: [], fieldErrors: [], windowListeners: {} };
  const named = {};
  for (const id of ['mcp-url', 'mcp-command', 'command-note', 'no-signin-note']) named[id] = makeEl(page, id);
  named['no-signin-note'].hidden = true;
  named['command-note'].hidden = true;
  const panel = container(page, 'agent-keys');
  const slot = container(page, 'account-slot');
  panel.hidden = true;
  slot.hidden = true;
  page.scrolled = 0; // how many times the key panel was scrolled into view
  panel.scrollIntoView = () => { page.scrolled++; };
  const lazy = new Map();
  for (const id of opts.hidden || []) { const e = makeEl(page, id); e.hidden = true; lazy.set(id, e); }
  const byId = (id) => {
    if (named[id]) return named[id];
    if (id === 'agent-keys') return panel;
    if (id === 'account-slot') return slot;
    for (const c of [panel, slot]) { const e = c.find(id); if (e) return e; }
    if (!opts.lazy) return null;
    if (!lazy.has(id)) lazy.set(id, makeEl(page, id));
    return lazy.get(id);
  };
  const UI = Object.assign({}, realUI, {
    byId,
    request: (method, url, body) => {
      page.requests.push({ method, url, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
      return Promise.resolve().then(() => opts.request(method, url, body));
    },
    loadConfig: () => Promise.resolve(opts.config === undefined ? { live: true, passcode: false, signin: 'github' } : opts.config),
    toast: (message, kind) => { page.toasts.push([message, kind]); },
    setBusy: (el, on) => { if (el) el.busy = Boolean(on); },
    disableAll() {},
    fieldError: (input, errEl, message) => { page.fieldErrors.push([input.id, message]); },
  });
  const win = {
    UI, RoomView, AccountView, Links,
    scrollTo() {},
    addEventListener(type, fn) { (page.windowListeners[type] = page.windowListeners[type] || []).push(fn); },
  };
  win.window = win;
  const store = new Map();
  const ctx = {
    window: win, URLSearchParams, URL, Promise, Date, setTimeout: opts.setTimeout || setTimeout,
    location: { origin: opts.origin || 'https://behalf.test', pathname: opts.pathname || '/connect', search: opts.search || '', hash: opts.hash || '', assign() {} },
    history: { replaceState: (a, b, u) => { page.replaced.push(u); } },
    document: { activeElement: null, title: '' },
    localStorage: { get length() { return store.size; }, key: (i) => [...store.keys()][i], getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  };
  runScripts(ctx, opts.scripts || ['account.js', 'connect.js']);
  page.byId = byId;
  page.el = byId;
  page.window = win;
  page.panelHtml = () => plain(panel.innerHTML);
  page.slotHtml = () => slot.innerHTML;
  page.slotText = () => slot.innerHTML.replace(/<[^>]*>/g, ''); // what is read out: the markup without its tags
  page.command = () => named['mcp-command'].textContent;
  page.html = (id) => plain(byId(id).innerHTML);
  page.fire = (type, event) => { for (const fn of page.windowListeners[type] || []) fn(event || {}); };
  page.flush = flush;
  page.meRequests = () => page.requests.filter((r) => r.url === '/api/me').length;
  return page;
}

// room-kit.js on its own, with a fake RoomApp: A.ui.act(...) writes the failure into slots[id].innerHTML.
function loadRoomKit() {
  const slots = {};
  const page = { focused: null };
  const document = { activeElement: null, body: { id: 'body' } };
  // The real UI.setBusy runs on the fake elements (aria-busy, and a control disabled while busy).
  const UI = Object.assign({}, realUI, { byId: (id) => slots[id] || (slots[id] = makeEl(page, id)) });
  const A = { BLOCKED: -1, pendingFocus: null, refresh: () => Promise.resolve(true) };
  const win = { UI, RoomView, RoomApp: A };
  win.window = win;
  runScripts({ window: win, document }, ['room-kit.js']);
  return { A, slots, document, html: (id) => plain(slots[id].innerHTML), reset: (id) => { slots[id] = undefined; } };
}

module.exports = { loadPage, loadRoomKit, makeEl, container, runScripts, flush, ok, refused, ME };
