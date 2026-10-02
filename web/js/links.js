/*
 * Link handling for the invite step: pure functions, no storage and no DOM.
 *
 * Rules:
 *  - The page owns localStorage. These functions only decide what to write, keep or delete.
 *  - Only the invited person's (seat B) link is ever stored, under the room id, and only for a
 *    /room/ link for that same room. No other seat's token is ever written.
 *  - A stored link is deleted once seat B has locked their instructions, or after 7 days.
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
  //   {action: 'delete'}      remove it: expired, seat B has locked, or it isn't a valid record
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
    return { action: 'keep', link: relativePath(rec.link) };
  }

  var Links = {
    INVITE_KEY_PREFIX: INVITE_KEY_PREFIX,
    INVITE_TTL_MS: INVITE_TTL_MS,
    rebaseLink: rebaseLink,
    inviteEntry: inviteEntry,
    inviteRecord: inviteRecord
  };

  if (typeof window !== 'undefined') window.Links = Links;
  else if (typeof module !== 'undefined' && module.exports) module.exports = Links;
})();
