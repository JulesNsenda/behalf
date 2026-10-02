'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { WEB } = require('../test-support/paths');
const { codeOf, assertPure } = require('../test-support/source');
const LINKS_PATH = path.join(WEB, 'js', 'links.js');

// No window here, so links.js sets module.exports.
assert.strictEqual(typeof globalThis.window, 'undefined');
const L = require(LINKS_PATH);

const ORIGIN = 'https://behalf.example';
const NOW = Date.UTC(2026, 9, 2);
const DAY = 24 * 60 * 60 * 1000;

// ---------- rebaseLink ----------
test('rebaseLink: keeps the path, query and hash on the given origin', () => {
  assert.strictEqual(L.rebaseLink('/room/abc123?seat=B&t=tok', ORIGIN), 'https://behalf.example/room/abc123?seat=B&t=tok');
  assert.strictEqual(L.rebaseLink('/room/abc123?seat=B&t=tok#top', ORIGIN), 'https://behalf.example/room/abc123?seat=B&t=tok#top');
  assert.strictEqual(L.rebaseLink('/room/abc123', 'http://localhost:3000'), 'http://localhost:3000/room/abc123');
  // an origin given with a path or trailing slash is reduced to its origin
  assert.strictEqual(L.rebaseLink('/room/abc?seat=B', 'https://behalf.example/some/page?x=1'), 'https://behalf.example/room/abc?seat=B');
});

test('rebaseLink: the host in a full URL never decides where the link points', () => {
  assert.strictEqual(L.rebaseLink('http://internal:3000/room/abc?seat=B&t=tok', ORIGIN), 'https://behalf.example/room/abc?seat=B&t=tok');
  assert.strictEqual(L.rebaseLink('https://evil.example/room/abc?t=1', ORIGIN), 'https://behalf.example/room/abc?t=1');
  // protocol-relative and backslash tricks are refused outright
  for (const bad of ['//evil.example/room/abc', '\\\\evil.example\\room\\abc', '/\\evil.example/room/abc']) {
    assert.strictEqual(L.rebaseLink(bad, ORIGIN), null, bad);
  }
});

test('rebaseLink: only http(s) input and only /room/ paths', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://x/room/abc', 'file:///room/abc', 'mailto:a@b.c', 'JaVaScRiPt:alert(1)']) {
    assert.strictEqual(L.rebaseLink(bad, ORIGIN), null, bad);
  }
  for (const bad of ['/', '/room', '/room/', '/rooms/abc', '/brief/abc', '/api/rooms/abc', '/room/../admin', '/x/room/abc', 'room/abc', '', '   ']) {
    assert.strictEqual(L.rebaseLink(bad, ORIGIN), null, JSON.stringify(bad));
  }
  assert.strictEqual(L.rebaseLink('/room/abc\n?x', ORIGIN), null, 'control characters');
  for (const v of [null, undefined, 42, {}, ['/room/abc']]) {
    assert.strictEqual(L.rebaseLink(v, ORIGIN), null);
    assert.strictEqual(L.rebaseLink('/room/abc', v), null);
  }
});

test('rebaseLink: the origin must be http(s) too', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///', 'not a url', '']) {
    assert.strictEqual(L.rebaseLink('/room/abc', bad), null, bad);
  }
});

// ---------- inviteEntry (what gets written) ----------
test('inviteEntry: stores only seat B\'s link for this room, under the room id', () => {
  const e = L.inviteEntry({ now: NOW, roomId: 'abc123', link: '/room/abc123?seat=B&t=tokB' });
  assert.strictEqual(e.key, L.INVITE_KEY_PREFIX + 'abc123');
  assert.deepStrictEqual(JSON.parse(e.value), { link: '/room/abc123?seat=B&t=tokB', savedAt: NOW });
  // only the path is stored (the page rebuilds the full link on its own origin), so a full URL is refused
  assert.strictEqual(L.inviteEntry({ now: NOW, roomId: 'abc123', link: 'https://x.example/room/abc123?seat=B&t=tokB' }), null);
  assert.strictEqual(L.inviteEntry({ now: NOW, roomId: 'abc123', link: '//x.example/room/abc123?seat=B&t=tokB' }), null);
});

test('inviteEntry: a token for any other seat, or any other room, is never written', () => {
  const w = (link, roomId = 'abc123') => L.inviteEntry({ now: NOW, roomId, link });
  assert.strictEqual(w('/room/abc123?seat=A&t=tokA'), null, 'the creator\'s own seat');
  assert.strictEqual(w('/room/abc123?t=tok'), null, 'no seat');
  assert.strictEqual(w('/room/abc123?seat=C&t=tok'), null);
  assert.strictEqual(w('/room/abc123?seat=b&t=tok'), null);
  assert.strictEqual(w('/room/other?seat=B&t=tok'), null, 'a different room');
  assert.strictEqual(w('/brief/abc123?seat=B'), null);
  assert.strictEqual(w('javascript:alert(1)'), null);
  assert.strictEqual(w('javascript:/room/abc123?seat=B'), null, 'a scheme is not a path');
  assert.strictEqual(w('https://evil.example/room/abc123?seat=B'), null);
  assert.strictEqual(w('/\evil.example/room/abc123?seat=B'), null, 'a backslash host is not a path');
  assert.strictEqual(w('/room/abc123?seat=B', '../x'), null, 'room ids are plain');
  assert.strictEqual(w('/room/abc123?seat=B', ''), null);
  assert.strictEqual(w(undefined), null);
  assert.strictEqual(L.inviteEntry({ roomId: 'abc123', link: '/room/abc123?seat=B' }), null, 'needs a time');
  assert.strictEqual(L.inviteEntry(), null);
});

// ---------- inviteRecord (keep, delete or nothing) ----------
const stored = (over) => JSON.stringify(Object.assign({ link: '/room/abc123?seat=B&t=tokB', savedAt: NOW - DAY }, over));
const open = { status: 'drafting', seats: { A: { sealed: true }, B: { sealed: false } } };

test('inviteRecord: nothing stored means nothing to do', () => {
  for (const s of [null, undefined, '']) assert.deepStrictEqual(L.inviteRecord({ now: NOW, stored: s, roomId: 'abc123', R: open }), { action: 'none' });
});

test('inviteRecord: keeps a fresh link while seat B has not locked', () => {
  const r = L.inviteRecord({ now: NOW, stored: stored(), roomId: 'abc123', R: open });
  assert.deepStrictEqual(r, { action: 'keep', link: '/room/abc123?seat=B&t=tokB' });
  // before the room has loaded there is nothing to compare, so it stays
  assert.strictEqual(L.inviteRecord({ now: NOW, stored: stored(), roomId: 'abc123' }).action, 'keep');
  // an already parsed record works too
  assert.strictEqual(L.inviteRecord({ now: NOW, stored: JSON.parse(stored()), roomId: 'abc123', R: open }).action, 'keep');
});

test('inviteRecord: expires after 7 days', () => {
  const at = (age) => L.inviteRecord({ now: NOW, stored: stored({ savedAt: NOW - age }), roomId: 'abc123', R: open }).action;
  assert.strictEqual(at(7 * DAY - 1), 'keep');
  assert.strictEqual(at(7 * DAY), 'keep', 'exactly 7 days is still inside');
  assert.strictEqual(at(7 * DAY + 1), 'delete');
  assert.strictEqual(at(30 * DAY), 'delete');
  assert.strictEqual(at(-DAY), 'delete', 'a time in the future is not trusted');
  assert.strictEqual(L.INVITE_TTL_MS, 7 * DAY);
});

test('inviteRecord: deleted once seat B has locked, in any status', () => {
  for (const status of ['drafting', 'negotiating', 'paused', 'agreed', 'stalled', 'error']) {
    const R = { status, seats: { A: { sealed: true }, B: { sealed: true } } };
    assert.deepStrictEqual(L.inviteRecord({ now: NOW, stored: stored(), roomId: 'abc123', R }), { action: 'delete' }, status);
  }
  // seat A locking says nothing about seat B
  assert.strictEqual(L.inviteRecord({ now: NOW, stored: stored(), roomId: 'abc123', R: { seats: { A: { sealed: true }, B: { sealed: false } } } }).action, 'keep');
});

test('inviteRecord: a record that is not this room\'s seat B link is deleted, never shown', () => {
  const r = (over, roomId = 'abc123') => L.inviteRecord({ now: NOW, stored: stored(over), roomId, R: open });
  assert.strictEqual(r({ link: '/room/abc123?seat=A&t=tokA' }).action, 'delete');
  assert.strictEqual(r({ link: '/room/other?seat=B&t=tok' }).action, 'delete');
  assert.strictEqual(r({ link: 'javascript:alert(1)' }).action, 'delete');
  assert.strictEqual(r({ link: 'javascript:/room/abc123?seat=B' }).action, 'delete');
  assert.strictEqual(r({ link: 'https://evil.example/room/abc123?seat=B' }).action, 'delete');
  assert.strictEqual(r({ link: '//evil.example/room/abc123?seat=B' }).action, 'delete');
  assert.strictEqual(r({ link: '/\evil.example/room/abc123?seat=B' }).action, 'delete');
  assert.strictEqual(r({ link: 42 }).action, 'delete');
  assert.strictEqual(r({ savedAt: 'yesterday' }).action, 'delete');
  assert.strictEqual(r({ savedAt: undefined }).action, 'delete');
  assert.strictEqual(r({}, 'other').action, 'delete', 'the key is by room id, so a different id never matches');
  assert.strictEqual(r({}, '').action, 'delete');
  for (const bad of ['not json', '{', '[]', '"x"', '42', 'null', 'true']) {
    assert.strictEqual(L.inviteRecord({ now: NOW, stored: bad, roomId: 'abc123', R: open }).action, 'delete', bad);
  }
  assert.strictEqual(L.inviteRecord({ stored: stored(), roomId: 'abc123', R: open }).action, 'delete', 'no clock, no trust');
  assert.deepStrictEqual(L.inviteRecord(), { action: 'none' });
});

test('inviteRecord: returns the normalised path, never the raw stored string', () => {
  const r = L.inviteRecord({ now: NOW, stored: stored({ link: '/room/abc123/../abc123?seat=B&t=tokB#x' }), roomId: 'abc123', R: open });
  assert.deepStrictEqual(r, { action: 'keep', link: '/room/abc123?seat=B&t=tokB#x' });
});

test('inviteEntry and inviteRecord agree: what is written is kept', () => {
  const e = L.inviteEntry({ now: NOW, roomId: 'abc123', link: '/room/abc123?seat=B&t=tokB' });
  assert.deepStrictEqual(L.inviteRecord({ now: NOW + DAY, stored: e.value, roomId: 'abc123', R: open }), { action: 'keep', link: '/room/abc123?seat=B&t=tokB' });
  assert.ok(e.key.startsWith(L.INVITE_KEY_PREFIX));
  assert.ok(typeof L.INVITE_KEY_PREFIX === 'string' && L.INVITE_KEY_PREFIX.length > 3);
});

// ---------- purity ----------
test('links is pure: no DOM, storage or regex constructor, and it writes nothing', () => {
  assertPure(codeOf(LINKS_PATH));
});
