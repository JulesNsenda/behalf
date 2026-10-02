/*
 * Room page core: the shared namespace window.RoomApp (A), the viewer's credentials, tab storage, the
 * room state every other room script reads, and the requests and live stream that keep it fresh. It uses
 * UI, RoomView and Links only; room.js hands it the hooks in A.load({onRoom, onGone, onLoadError}).
 *
 * The viewer's token comes from the link's ?t=, which stays in the address bar on purpose: the link IS the
 * person's way back into their seat, and the token already travels in API query strings, so hiding it from
 * the address bar would gain little and lock people out of their room. Links.credentials (links.js) reads
 * it and decides what the tab keeps. It travels in:
 *  - GET and event-stream query strings, and POST bodies;
 *  - the agent prompt shown to that same person;
 *  - this tab's sessionStorage (behalf.seat.<room>.<seat>), written only once the server has confirmed the
 *    seat, and used only as a fallback when the URL has ?seat= but no ?t=. A token the server turns down is
 *    deleted from it again.
 * It is never written into an href and never put in localStorage.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var RV = window.RoomView;
  var Links = window.Links;

  var A = window.RoomApp = {};

  // ---------- storage (every call guarded) ----------

  // Reading window[area] can itself throw (storage blocked), so it is read once, guarded.
  function safeStore(area) {
    var store = null;
    try { store = window[area]; } catch (e) { /* storage unavailable */ }
    return {
      get: function (key) { try { return store.getItem(key); } catch (e) { return null; } },
      set: function (key, v) { try { store.setItem(key, v); } catch (e) { /* storage unavailable */ } },
      del: function (key) { try { store.removeItem(key); } catch (e) { /* storage unavailable */ } }
    };
  }

  var tab = safeStore('sessionStorage');
  A.store = tab;

  // ---------- url, identity ----------

  // The link's room, seat and token, or this tab's saved token for the seat. Nothing is saved until the
  // server confirms the seat (cred.settle, in sideEffects).
  var cred = Links.credentials({
    search: location.search,
    pathname: location.pathname,
    storage: { getItem: tab.get, setItem: tab.set, removeItem: tab.del }
  });
  var badId = cred.roomId === null;
  A.cred = cred;
  A.roomId = badId ? '' : cred.roomId;

  function roomApi(rest) { return '/api/rooms/' + encodeURIComponent(A.roomId) + rest; }

  A.ledgerPath = function () { return roomApi('/ledger'); };

  // ---------- state ----------

  A.room = null;
  A.text = RV.pageText(null);
  A.step = null; // the current RoomView.step result; null forces the next view to mount its step afresh
  // What a person's own action expects next, so the page can tell it from a change the server made:
  //   steps  the step keys the action leads to; arriving at one moves focus to its heading
  //   kind, seq  an answer: focus the new "You answered" line of that message
  A.pendingFocus = null;
  A.reduceMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  A.inviteLink = null; // Kwame's invite link while this room still shows it

  function seatKey() { return A.roomId + '.' + ((A.room && A.room.seat) || cred.seat || ''); }
  function flagKey(kind) { return 'behalf.' + kind + '.' + seatKey(); }

  A.flagOn = function (kind) { return tab.get(flagKey(kind)) === '1'; };
  A.setFlag = function (kind) { tab.set(flagKey(kind), '1'); };
  A.ownChoice = function () { return tab.get(flagKey('who')) === 'own'; };
  A.setOwnChoice = function (own) { tab.set(flagKey('who'), own ? 'own' : 'builtin'); };

  A.draftKey = function () { return 'behalf.draft.' + seatKey(); };
  A.clearDraft = function () { tab.del(A.draftKey()); };

  A.stepCtx = function () {
    return { hadCredentials: cred.hadCredentials, previewSeat: cred.previewSeat, welcomeSeen: A.flagOn('welcome'), demoStarted: A.flagOn('demo') };
  };

  A.mine = function () { return A.room && A.room.seat && A.room.seats ? A.room.seats[A.room.seat] : null; };

  // The viewer's own room link for their agent, built from validated parts only. Empty until the server
  // has confirmed the seat, and without a token.
  A.promptLink = function () {
    return A.room && RV.isSeat(A.room.seat) ? cred.promptLink(location.origin) : '';
  };

  // ---------- storage side effects ----------

  // Kwame's invite link: kept in localStorage by the start page. Applies this room's rule to its entry.
  function syncInvite() {
    A.inviteLink = null;
    try {
      var key = Links.INVITE_KEY_PREFIX + A.roomId;
      var rec = Links.inviteRecord({ stored: window.localStorage.getItem(key), roomId: A.roomId, now: Date.now(), R: A.room });
      if (rec.action === 'delete') window.localStorage.removeItem(key);
      else if (rec.action === 'keep' && A.room.seat === 'A' && !A.room.demo) A.inviteLink = Links.rebaseLink(rec.link, location.origin);
    } catch (e) { /* storage unavailable */ }
  }

  // Everything a new room view writes to storage.
  A.sideEffects = function () {
    syncInvite();
    var s = A.mine();
    if (s && s.sealed) A.clearDraft();
    cred.settle(A.room);
  };

  // Sweeps dead invite entries from localStorage. Called once by room.js at boot.
  A.init = function () {
    try { Links.sweep(window.localStorage, Date.now()); } catch (e) { /* storage unavailable */ }
  };

  // ---------- requests ----------

  // A seat action. Only a confirmed seat on a step that can act may send anything.
  // Refused before sending, it answers with A.BLOCKED: a status no message list knows, so it reads as the
  // generic message and never as "not allowed".
  A.BLOCKED = -1;
  A.post = function (seat, action, body) {
    if (!(A.room && A.room.seat && A.step && !A.step.readOnly)) return Promise.resolve({ ok: false, status: A.BLOCKED, data: {} });
    return UI.request('POST', roomApi('/seats/' + seat + '/' + action), cred.body(body));
  };

  // One GET of the room after something succeeded, so the page doesn't wait for the stream. Resolves to
  // true when a new valid view was applied, false otherwise.
  A.refresh = function () {
    return UI.request('GET', roomApi('') + cred.query()).then(function (res) {
      return Boolean(res.ok && hooks.onRoom(res.data));
    });
  };

  // Shows the current room again, e.g. after a flag a step set. It goes through the same guarded path as
  // a new view, so a step never calls the page's renderer itself.
  A.requestRender = function () { return hooks.onRoom(A.room); };

  // ---------- live updates ----------

  var stream = null;
  var failures = 0;
  var retry = null;
  var hooks = null; // {onRoom, onGone, onLoadError}, handed in by A.load
  var roomCheck = 'idle'; // idle, running, or done: one look at the room that got an answer from the server

  A.validRoom = function (v) {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v) &&
      Boolean(v.seats) && typeof v.seats === 'object' && !Array.isArray(v.seats) && typeof v.id === 'string';
  };

  function setReconnecting(on) {
    var el = UI.byId('room-reconnect');
    el.textContent = on ? RV.pageText(A.room).reconnecting : '';
    el.hidden = !on;
  }

  // After three failures in a row, one look at the room tells a dead stream from a room that is gone.
  // If the server can't be reached for that look either, it is tried again on the next failure.
  function checkRoom() {
    roomCheck = 'running';
    UI.request('GET', roomApi('') + cred.query()).then(function (res) {
      roomCheck = res.status === 0 ? 'idle' : 'done';
      if (res.status !== 404) return;
      if (stream) { stream.close(); stream = null; }
      clearTimeout(retry);
      setReconnecting(false);
      hooks.onGone();
    });
  }

  function connect() {
    stream = new EventSource(roomApi('/events') + cred.query());
    stream.onopen = function () { failures = 0; roomCheck = 'idle'; setReconnecting(false); };
    stream.onmessage = function (ev) {
      var v;
      try { v = JSON.parse(ev.data); } catch (e) { return; }
      hooks.onRoom(v);
    };
    stream.onerror = function () {
      this.close();
      stream = null;
      failures++;
      setReconnecting(true);
      if (failures >= 3 && roomCheck === 'idle') checkRoom();
      retry = setTimeout(connect, RV.backoffMs(failures, Math.random()));
    };
  }

  // The first look at the room, then the live stream. Every hook is required.
  A.load = function (h) {
    if (!h || typeof h.onRoom !== 'function' || typeof h.onGone !== 'function' || typeof h.onLoadError !== 'function') {
      throw new Error('A.load needs onRoom, onGone and onLoadError');
    }
    hooks = h;
    if (badId) { hooks.onGone(); return; }
    UI.request('GET', roomApi('') + cred.query()).then(function (res) {
      if (res.status === 404) { hooks.onGone(); return; }
      if (!res.ok) { hooks.onLoadError(res.status); return; }
      if (!A.validRoom(res.data)) { hooks.onLoadError(500); return; }
      hooks.onRoom(res.data);
      connect();
    });
  };
})();
