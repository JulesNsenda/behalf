/*
 * Link handling for the room, invite and agreement pages: functions that take what they need (a
 * search string, a path, a storage object) and touch no DOM and no global.
 *
 * Rules:
 *  - The page owns localStorage. These functions only decide what to write, keep or delete.
 *  - A seat's token reaches a page in the link's ?t=. credentials() reads it (or this tab's saved copy)
 *    and settle() decides, once the server has answered, whether the tab keeps it. The path builders
 *    (roomPath, briefPath, previewPath) never take a token: only seatLink and demoUrl carry one.
 *  - Only the invited person's (seat B) link is ever stored, under the room id, and only for a
 *    /room/ link for that same room. No other seat's token is ever written.
 *  - A stored link is deleted once seat B has locked their instructions, once the room is past drafting, or after 7 days.
 */
(function () {
  'use strict';

  var INVITE_KEY_PREFIX = 'behalf.invite.';
  var INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // Room ids are short URL-safe strings.
  var ROOM_ID = /^[A-Za-z0-9_-]+$/;

  function isFiniteNumber(n) { return typeof n === 'number' && isFinite(n); }

  function parseUrl(value, base) {
    try { return base ? new URL(value, base) : new URL(value); } catch (e) { return null; }
  }

  function isHttp(u) { return Boolean(u) && (u.protocol === 'http:' || u.protocol === 'https:'); }

  // The API's link is a path like "/room/ID?seat=B&t=TOKEN". Put its path, query and hash on this
  // page's origin, so a server-supplied host can never decide where a link points. Returns null for
  // anything that isn't an http(s) /room/ link.
  function rebaseLink(apiLink, origin) {
    if (typeof apiLink !== 'string' || typeof origin !== 'string') return null;
    var link = apiLink.trim();
    if (/^[\\/]{2}/.test(link) || /[\u0000-\u001f]/.test(link)) return null;
    if (link.charAt(0) !== '/' && !/^https?:/i.test(link)) return null;
    var base = parseUrl(origin);
    if (!isHttp(base)) return null;
    var u = parseUrl(link, base.origin);
    if (!isHttp(u)) return null;
    if (u.pathname.indexOf('/room/') !== 0 || u.pathname.length <= '/room/'.length) return null;
    return base.origin + u.pathname + u.search + u.hash;
  }

  function parseStored(stored) {
    if (stored && typeof stored === 'object') return stored;
    if (typeof stored !== 'string') return null;
    try {
      var v = JSON.parse(stored);
      return v && typeof v === 'object' ? v : null;
    } catch (e) { return null; }
  }

  // The link as a same-origin path: "/room/ID?seat=B&t=TOKEN" (path, query, hash). Null for anything
  // else: a full URL, a scheme, "//host", or a link that parses to another origin.
  function relativePath(link) {
    if (typeof link !== 'string' || link.charAt(0) !== '/' || link.charAt(1) === '/') return null;
    var u = parseUrl(link, 'http://x');
    return u && u.origin === 'http://x' ? u.pathname + u.search + u.hash : null;
  }

  // True for the invited person's (seat B) link to this room, given as a relative path.
  function isInviteLink(link, roomId) {
    if (typeof roomId !== 'string' || !ROOM_ID.test(roomId) || relativePath(link) === null) return false;
    var u = parseUrl(link, 'http://x');
    return u.pathname === '/room/' + roomId && u.searchParams.get('seat') === 'B';
  }

  // What to save after creating a room: {key, value} for the invited person's link, else null.
  // link is the seat B link from the create response, a path like "/room/ID?seat=B&t=TOKEN".
  // Only the path is stored; the page rebuilds the full link on its own origin (see rebaseLink).
  function inviteEntry(args) {
    args = args || {};
    var roomId = args.roomId;
    var link = typeof args.link === 'string' ? args.link.trim() : '';
    if (!isInviteLink(link, roomId) || !isFiniteNumber(args.now)) return null;
    return {
      key: INVITE_KEY_PREFIX + roomId,
      value: JSON.stringify({ link: relativePath(link), savedAt: args.now })
    };
  }

  // What to do with the stored invite for a room.
  //   {action: 'keep', link}  show it again; link is the normalised path, never the raw stored string
  //   {action: 'delete'}      remove it: expired, seat B has locked, the room is past drafting, or it isn't a valid record
  //   {action: 'none'}        nothing stored
  // stored is the raw stored string (or an already parsed object). R is the room view, if loaded.
  function inviteRecord(args) {
    args = args || {};
    var stored = args.stored;
    if (stored == null || stored === '') return { action: 'none' };
    var rec = parseStored(stored);
    if (!rec || typeof rec.link !== 'string' || !isFiniteNumber(rec.savedAt) || !isFiniteNumber(args.now)) return { action: 'delete' };
    // Only the invited person's link for this room is ever kept.
    if (!isInviteLink(rec.link, args.roomId)) return { action: 'delete' };
    var age = args.now - rec.savedAt;
    if (age < 0 || age > INVITE_TTL_MS) return { action: 'delete' };
    var R = args.R;
    if (R && R.seats && R.seats.B && R.seats.B.sealed) return { action: 'delete' };
    // Once the room is past drafting the invite has done its job, sealed or not.
    if (R && typeof R.status === 'string' && R.status !== 'drafting') return { action: 'delete' };
    return { action: 'keep', link: relativePath(rec.link) };
  }

  // Removes every stored invite that inviteRecord says to delete (expired, malformed, or for a room
  // other than the key's). It never throws, so a broken store can't fail the page.
  function sweep(storage, now) {
    try {
      var keys = [];
      for (var i = 0; i < storage.length; i++) {
        var k = storage.key(i);
        if (typeof k === 'string' && k.indexOf(INVITE_KEY_PREFIX) === 0) keys.push(k);
      }
      keys.forEach(function (k) {
        try {
          var rec = inviteRecord({ stored: storage.getItem(k), roomId: k.slice(INVITE_KEY_PREFIX.length), now: now });
          if (rec.action === 'delete') storage.removeItem(k);
        } catch (e) { /* leave this one */ }
      });
    } catch (e) { /* store unavailable */ }
  }

  // The room id in a path like "/brief/ID", or null when there isn't a valid one: no id, a bad
  // percent escape, or characters a room id never has.
  function roomIdFromPath(pathname, prefix) {
    if (typeof pathname !== 'string' || typeof prefix !== 'string' || pathname.indexOf(prefix) !== 0) return null;
    var rest = pathname.slice(prefix.length);
    if (rest.charAt(rest.length - 1) === '/') rest = rest.slice(0, -1);
    var id;
    try { id = decodeURIComponent(rest); } catch (e) { return null; }
    return ROOM_ID.test(id) ? id : null;
  }

  // ---------- seat credentials ----------

  var TAB_KEY_PREFIX = 'behalf.seat.';

  function isSeat(s) { return s === 'A' || s === 'B'; }

  // The seat in a query string like "?seat=B&t=...", or null when it isn't a valid one.
  function seatFromSearch(search) {
    var seat = new URLSearchParams(typeof search === 'string' ? search : '').get('seat');
    return isSeat(seat) ? seat : null;
  }

  // "?seat=A" for a valid seat, else nothing: the one place a seat goes into a link without a token.
  function seatQuery(seat) { return isSeat(seat) ? '?seat=' + seat : ''; }

  function idOk(id) { return typeof id === 'string' && id !== ''; }

  // The page for a room, as a same-origin path. It carries the seat (wording and the saved token's
  // key) and never a token. Null without an id.
  function roomPath(id, seat) { return idOk(id) ? '/room/' + encodeURIComponent(id) + seatQuery(seat) : null; }

  // The agreement page for a room: the seat only chooses wording. Null without an id.
  function briefPath(id, seat) { return idOk(id) ? '/brief/' + encodeURIComponent(id) + seatQuery(seat) : null; }

  // The token-free look at what a seat will see. Null without an id or a valid seat.
  function previewPath(id, seat) {
    return idOk(id) && isSeat(seat) ? '/room/' + encodeURIComponent(id) + '?preview=' + seat : null;
  }

  // A seat's own link, with its token, on the given origin (use '' for a path). Empty without a valid
  // seat, an id and a token. This and demoUrl are the only builders that carry a token.
  function seatLink(origin, id, seat, token) {
    if (!isSeat(seat) || !idOk(id) || typeof token !== 'string' || token === '') return '';
    return (typeof origin === 'string' ? origin : '') + '/room/' + encodeURIComponent(id) + '?seat=' + seat + '&t=' + encodeURIComponent(token);
  }

  // The seat token in a seat link ("?t=TOKEN"), or '' when the link has none.
  function tokenOf(link) {
    var u = parseUrl(link, 'http://x');
    return (u && u.searchParams.get('t')) || '';
  }

  // Where the demo's creator goes: seat A with the room's one shared token. Null unless id and token are strings.
  function demoUrl(data) {
    if (!data || !idOk(data.id) || typeof data.token !== 'string' || data.token === '') return null;
    return seatLink('', data.id, 'A', data.token);
  }

  function storageGet(storage, key) {
    try { return storage ? storage.getItem(key) : null; } catch (e) { return null; }
  }

  function storageSet(storage, key, value) {
    try { if (storage) storage.setItem(key, value); } catch (e) { /* storage unavailable */ }
  }

  function storageDel(storage, key) {
    try { if (storage) storage.removeItem(key); } catch (e) { /* storage unavailable */ }
  }

  // Who the viewer says they are, from the link and this tab's storage:
  //   {roomId, seat, token, source, previewSeat, hadCredentials}
  //   roomId           from the path, or null when the path has no valid room id
  //   seat             the link's ?seat= when it is A or B, else null
  //   token            the link's ?t=, else this tab's saved token for that seat, else ''
  //   source           where the token came from: 'url', 'tab' or 'none'
  //   previewSeat      the link's ?preview=, as given (or null)
  //   hadCredentials   a token was actually presented, from the link or the tab
  // plus the methods below. None of this is proof of anything: the server confirms the seat (R.seat), and
  // settle() makes the storage agree with its answer.
  function credentials(args) {
    args = args || {};
    var q = new URLSearchParams(typeof args.search === 'string' ? args.search : '');
    var storage = args.storage;
    var roomId = roomIdFromPath(args.pathname, '/room/');
    var seat = seatFromSearch(args.search);
    var key = seat && roomId !== null ? TAB_KEY_PREFIX + roomId + '.' + seat : '';
    var urlToken = q.get('t') || '';
    var saved = key ? storageGet(storage, key) : null;
    var tabToken = typeof saved === 'string' ? saved : '';
    var token = urlToken || tabToken;

    var c = {
      roomId: roomId,
      seat: seat,
      token: token,
      source: urlToken ? 'url' : tabToken ? 'tab' : 'none',
      previewSeat: q.get('preview'),
      hadCredentials: token !== ''
    };

    // "?seat=..&t=.." for the room's GET and event-stream URLs, or '' when there is neither.
    c.query = function () {
      var out = new URLSearchParams();
      if (seat) out.set('seat', seat);
      if (token) out.set('t', token);
      var s = out.toString();
      return s ? '?' + s : '';
    };

    // A POST body: the token, then whatever the action adds.
    c.body = function (extra) { return Object.assign({ token: token }, extra); };

    // The viewer's own seat link for their agent. Empty without a seat, a room and a token.
    c.promptLink = function (origin) { return seatLink(origin, roomId, seat, token); };

    // True when the text holds the token, as written or percent-encoded. False when there is no token.
    c.containsToken = function (text) {
      if (!token || typeof text !== 'string') return false;
      return text.indexOf(token) !== -1 || text.indexOf(encodeURIComponent(token)) !== -1;
    };

    // Saves the link's token for this tab, so a link with ?seat= and no ?t= finds it again. settle() calls
    // this only after the server has confirmed the seat; nothing else should.
    c.remember = function () {
      if (key && urlToken) storageSet(storage, key, urlToken);
    };

    // Makes the tab's storage agree with the server's answer for this link (R is a room view):
    //  - the server confirmed the very seat the link names: the link's token is remembered;
    //  - a token was presented and the server did not confirm that seat (a demo room included): whatever
    //    this tab saved for the seat is deleted when it is the rejected token (or the token came from the
    //    tab), so a rejected token is never offered again; a different saved token survives. The rejected
    //    token is dropped from memory too: query, body and promptLink send none. hadCredentials stays true.
    // Nothing is touched when no token was presented.
    c.settle = function (R) {
      if (!key || !R || typeof R !== 'object') return;
      if (R.seat === seat) c.remember();
      else if (c.hadCredentials) {
        var now = storageGet(storage, key);
        if (c.source === 'tab' || now === token) storageDel(storage, key);
        token = '';
        c.token = '';
      }
    };

    return c;
  }

  var Links = {
    INVITE_KEY_PREFIX: INVITE_KEY_PREFIX,
    INVITE_TTL_MS: INVITE_TTL_MS,
    rebaseLink: rebaseLink,
    inviteEntry: inviteEntry,
    inviteRecord: inviteRecord,
    sweep: sweep,
    roomIdFromPath: roomIdFromPath,
    credentials: credentials,
    seatFromSearch: seatFromSearch,
    seatQuery: seatQuery,
    roomPath: roomPath,
    briefPath: briefPath,
    previewPath: previewPath,
    seatLink: seatLink,
    tokenOf: tokenOf,
    demoUrl: demoUrl
  };

  if (typeof window !== 'undefined') window.Links = Links;
  else if (typeof module !== 'undefined' && module.exports) module.exports = Links;
})();
