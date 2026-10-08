'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { loadPure } = require('../test-support/source');

// No window here, so links.js sets module.exports.
const { mod: L, assertClean } = loadPure('links');

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

// ---------- sweep ----------
function fakeStore(initial) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    removeItem: (k) => { m.delete(k); },
  };
}

test('sweep: removes expired, malformed and mismatched invites and keeps the live one', () => {
  const live = L.inviteEntry({ now: NOW, roomId: 'live1', link: '/room/live1?seat=B&t=tokB' });
  const old = L.inviteEntry({ now: NOW - 8 * DAY, roomId: 'old1', link: '/room/old1?seat=B&t=tokB' });
  const other = L.inviteEntry({ now: NOW, roomId: 'other', link: '/room/other?seat=B&t=tokB' });
  const store = fakeStore({
    [live.key]: live.value,
    [old.key]: old.value, // expired, and for another room than the live one
    [L.INVITE_KEY_PREFIX + 'bad1']: '{not json',
    [L.INVITE_KEY_PREFIX + 'mixed']: other.value, // a valid record stored under a different room's key
    [L.INVITE_KEY_PREFIX + 'seatA']: JSON.stringify({ link: '/room/seatA?seat=A&t=x', savedAt: NOW }),
    unrelated: 'keep me',
  });
  L.sweep(store, NOW);
  assert.deepStrictEqual([...store.m.keys()].sort(), [live.key, 'unrelated'].sort());
});

test('sweep: an empty store, a throwing store and a throwing entry never throw', () => {
  L.sweep(fakeStore({}), NOW);
  L.sweep({ get length() { throw new Error('denied'); } }, NOW);
  L.sweep(null, NOW);
  const store = fakeStore({ [L.INVITE_KEY_PREFIX + 'a1']: 'x', [L.INVITE_KEY_PREFIX + 'b1']: 'y' });
  const real = store.removeItem;
  let calls = 0;
  store.removeItem = (k) => { calls++; if (calls === 1) throw new Error('quota'); real(k); };
  L.sweep(store, NOW);
  assert.strictEqual(calls, 2, 'one failure does not stop the rest');
  assert.strictEqual(store.m.size, 1);
});

// ---------- roomIdFromPath ----------
test('roomIdFromPath: the id, or null for anything that is not one', () => {
  assert.strictEqual(L.roomIdFromPath('/brief/abc123', '/brief/'), 'abc123');
  assert.strictEqual(L.roomIdFromPath('/brief/abc_1-2/', '/brief/'), 'abc_1-2');
  assert.strictEqual(L.roomIdFromPath('/brief/ab%63', '/brief/'), 'abc');
  for (const bad of ['/brief/', '/brief', '/brief/%E0%A4%A', '/brief/%', '/brief/a/b', '/brief/a%2Fb', '/brief/a b', '/brief/%3Cb%3E', '/room/abc', '', null, 5]) {
    assert.strictEqual(L.roomIdFromPath(bad, '/brief/'), null, String(bad));
  }
  assert.strictEqual(L.roomIdFromPath('/brief/abc', 5), null);
});

// ---------- purity ----------
test('links is pure: no DOM, storage or regex constructor, and it writes nothing', () => {
  assertClean();
});

test('inviteRecord: deleted once the room is past drafting, even if seat B never locked', () => {
  for (const status of ['negotiating', 'paused', 'agreed', 'stalled', 'error']) {
    const R = { status, seats: { A: { sealed: true }, B: { sealed: false } } };
    assert.deepStrictEqual(L.inviteRecord({ now: NOW, stored: stored(), roomId: 'abc123', R }), { action: 'delete' }, status);
  }
  assert.strictEqual(L.inviteRecord({ now: NOW, stored: stored(), roomId: 'abc123', R: open }).action, 'keep', 'still drafting');
  // the page's sweep has no room view, so it must not delete on this rule
  assert.strictEqual(L.inviteRecord({ now: NOW, stored: stored(), roomId: 'abc123' }).action, 'keep');
});

// ---------- credentials ----------
// A fake tab storage that records every call, and one that throws.
function fakeStorage(initial) {
  const data = Object.assign({}, initial);
  const calls = [];
  return {
    data, calls,
    getItem(k) { calls.push(['get', k]); return k in data ? data[k] : null; },
    setItem(k, v) { calls.push(['set', k, v]); data[k] = String(v); },
    removeItem(k) { calls.push(['remove', k]); delete data[k]; },
  };
}
const throwingStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
const cred = (search, storage, pathname = '/room/abc123') => L.credentials({ search, pathname, storage });
const KEY_B = 'behalf.seat.abc123.B';
const writes = (s) => s.calls.filter((c) => c[0] !== 'get');

test('credentials: a full link gives the room, seat and token from the link', () => {
  const c = cred('?seat=B&t=tok-1', fakeStorage());
  assert.deepStrictEqual({ roomId: c.roomId, seat: c.seat, token: c.token, source: c.source, previewSeat: c.previewSeat, hadCredentials: c.hadCredentials },
    { roomId: 'abc123', seat: 'B', token: 'tok-1', source: 'url', previewSeat: null, hadCredentials: true });
});

test('credentials: a link with a seat and no token uses this tab\'s saved token', () => {
  const c = cred('?seat=B', fakeStorage({ [KEY_B]: 'saved' }));
  assert.deepStrictEqual([c.token, c.source, c.hadCredentials], ['saved', 'tab', true]);
  assert.strictEqual(cred('?seat=A', fakeStorage({ [KEY_B]: 'saved' })).token, '', 'the other seat\'s token is not used');
  assert.strictEqual(cred('?seat=B', fakeStorage({ 'behalf.seat.other.B': 'saved' })).token, '', 'nor another room\'s');
  assert.strictEqual(cred('?seat=B&t=url', fakeStorage({ [KEY_B]: 'saved' })).token, 'url', 'the link wins over the tab');
});

test('credentials: hadCredentials is true only when a token was actually presented', () => {
  for (const search of ['', '?seat=B', '?seat=A', '?seat=Z', '?t=', '?seat=B&t=', '?preview=B']) {
    const c = cred(search, fakeStorage());
    assert.deepStrictEqual([c.hadCredentials, c.source, c.token], [false, 'none', ''], search || '(empty)');
  }
  assert.strictEqual(cred('?t=tok', fakeStorage()).hadCredentials, true, 'a token without a seat was still presented');
  assert.strictEqual(cred('?seat=B', fakeStorage({ [KEY_B]: 'saved' })).hadCredentials, true, 'from the tab');
});

test('credentials: the seat must be A or B, the room id valid, the preview kept as given', () => {
  assert.strictEqual(cred('?seat=C&t=x', fakeStorage()).seat, null);
  assert.strictEqual(cred('?seat=b&t=x', fakeStorage()).seat, null);
  assert.strictEqual(cred('?seat=A&t=x', fakeStorage(), '/room/%E0%A4%A').roomId, null);
  assert.strictEqual(cred('?seat=A&t=x', fakeStorage(), '/room/a%2Fb').roomId, null);
  assert.strictEqual(cred('?seat=A&t=x', fakeStorage(), '/room/').roomId, null);
  assert.strictEqual(cred('?seat=A&t=x', fakeStorage(), '/brief/abc').roomId, null);
  assert.strictEqual(cred('?preview=B', fakeStorage()).previewSeat, 'B');
  assert.strictEqual(cred('?preview=zzz', fakeStorage()).previewSeat, 'zzz');
  const s = fakeStorage({ [KEY_B]: 'saved' });
  assert.strictEqual(cred('?seat=B', s, '/room/%E0%A4%A').token, '', 'no room id, no saved token');
  assert.deepStrictEqual(s.calls, [], 'storage is not even asked');
  const none = L.credentials();
  assert.deepStrictEqual([none.roomId, none.seat, none.token, none.hadCredentials], [null, null, '', false]);
});

test('credentials: missing or throwing storage is the same as an empty one', () => {
  for (const storage of [undefined, null, throwingStorage]) {
    const c = cred('?seat=B&t=url', storage);
    assert.deepStrictEqual([c.token, c.source], ['url', 'url']);
    assert.strictEqual(cred('?seat=B', storage).token, '');
    assert.doesNotThrow(() => { c.remember(); c.settle({ seat: 'B' }); c.settle({ seat: null }); });
  }
});

test('credentials: nothing is written when the link is read', () => {
  const s = fakeStorage();
  cred('?seat=B&t=url', s);
  assert.deepStrictEqual(writes(s), []);
});

test('credentials.query: ?seat and ?t as the room endpoints take them, empty when there is neither', () => {
  assert.strictEqual(cred('?seat=B&t=tok', fakeStorage()).query(), '?seat=B&t=tok');
  assert.strictEqual(cred('?seat=B&t=a%26b%3D', fakeStorage()).query(), '?seat=B&t=a%26b%3D', 'the token stays encoded');
  assert.strictEqual(cred('?seat=B', fakeStorage()).query(), '?seat=B');
  assert.strictEqual(cred('?seat=B', fakeStorage({ [KEY_B]: 'saved' })).query(), '?seat=B&t=saved');
  assert.strictEqual(cred('', fakeStorage()).query(), '');
  assert.strictEqual(cred('?preview=B', fakeStorage()).query(), '', 'a preview link carries no credentials');
});

test('credentials.body: the token, then what the action adds', () => {
  const c = cred('?seat=B&t=tok', fakeStorage());
  assert.deepStrictEqual(c.body(), { token: 'tok' });
  assert.deepStrictEqual(c.body({ card: { goal: 'g' } }), { token: 'tok', card: { goal: 'g' } });
  assert.deepStrictEqual(c.body({ option: 'dedupe' }), { token: 'tok', option: 'dedupe' });
  assert.deepStrictEqual(cred('', fakeStorage()).body({ a: 1 }), { token: '', a: 1 });
});

test('credentials.promptLink: the viewer\'s own seat link on the origin given, empty without a seat or token', () => {
  assert.strictEqual(cred('?seat=B&t=tok', fakeStorage()).promptLink(ORIGIN), ORIGIN + '/room/abc123?seat=B&t=tok');
  assert.strictEqual(cred('?seat=B&t=a%26b%3D%20', fakeStorage()).promptLink(ORIGIN), ORIGIN + '/room/abc123?seat=B&t=a%26b%3D%20');
  assert.strictEqual(cred('?seat=B', fakeStorage({ [KEY_B]: 'saved' })).promptLink(ORIGIN), ORIGIN + '/room/abc123?seat=B&t=saved');
  assert.strictEqual(cred('?seat=B', fakeStorage()).promptLink(ORIGIN), '');
  assert.strictEqual(cred('?t=tok', fakeStorage()).promptLink(ORIGIN), '');
  assert.strictEqual(cred('?seat=B&t=tok', fakeStorage(), '/room/').promptLink(ORIGIN), '');
});

test('credentials.containsToken: the token as written or percent-encoded, never for an empty token', () => {
  const c = cred('?seat=B&t=ab%2Bc%2Fd', fakeStorage()); // the token is "ab+c/d"
  assert.strictEqual(c.token, 'ab+c/d');
  assert.strictEqual(c.containsToken('here it is: ab+c/d ok'), true);
  assert.strictEqual(c.containsToken('here it is: ab%2Bc%2Fd ok'), true);
  assert.strictEqual(c.containsToken('ab+c'), false);
  assert.strictEqual(c.containsToken(''), false);
  for (const odd of [null, undefined, 42, {}]) assert.strictEqual(c.containsToken(odd), false);
  const empty = cred('', fakeStorage());
  assert.strictEqual(empty.containsToken('anything'), false, 'an empty token is never found');
  assert.strictEqual(empty.containsToken(''), false);
  assert.strictEqual(cred('?seat=B&t=.*', fakeStorage()).containsToken('xyz'), false, 'the token is never a pattern');
  assert.strictEqual(cred('?seat=B&t=.*', fakeStorage()).containsToken('a .* b'), true);
});

test('settle: the link\'s token is saved only once the server confirms the seat the link names', () => {
  const s = fakeStorage();
  const c = cred('?seat=B&t=url', s);
  c.settle({ seat: 'B' });
  assert.deepStrictEqual(writes(s), [['set', KEY_B, 'url']]);
  assert.strictEqual(s.data[KEY_B], 'url');
  // the server confirmed another seat, or none: nothing is saved
  for (const R of [{ seat: 'A' }, { seat: null }, {}]) {
    const s2 = fakeStorage();
    cred('?seat=B&t=url', s2).settle(R);
    assert.ok(!writes(s2).some((w) => w[0] === 'set'), JSON.stringify(R));
  }
});

test('settle: a token that came from the tab is not written back', () => {
  const s = fakeStorage({ [KEY_B]: 'saved' });
  cred('?seat=B', s).settle({ seat: 'B' });
  assert.deepStrictEqual(writes(s), []);
  assert.strictEqual(s.data[KEY_B], 'saved');
});

test('settle: a token that was presented and turned down is deleted from the tab, demo rooms included', () => {
  for (const R of [{ seat: null }, { seat: null, demo: true }, { seat: 'A' }, { seat: null, demo: false }]) {
    const fromTab = fakeStorage({ [KEY_B]: 'saved' });
    cred('?seat=B', fromTab).settle(R);
    assert.ok(!(KEY_B in fromTab.data), 'tab token deleted: ' + JSON.stringify(R));
    const sameUrl = fakeStorage({ [KEY_B]: 'nope' });
    cred('?seat=B&t=nope', sameUrl).settle(R);
    assert.ok(!(KEY_B in sameUrl.data), 'the rejected token itself is deleted: ' + JSON.stringify(R));
    assert.ok(!writes(sameUrl).some((w) => w[0] === 'set'), 'a rejected token is never saved');
  }
});

test('settle: a rejected link token leaves a different saved token alone', () => {
  const s = fakeStorage({ [KEY_B]: 'good' });
  cred('?seat=B&t=stale', s).settle({ seat: null });
  assert.strictEqual(s.data[KEY_B], 'good');
  assert.ok(!writes(s).some((w) => w[0] === 'set' || w[0] === 'del'));
});

test('settle: after a rejection nothing sends the rejected token, and hadCredentials stays true', () => {
  for (const [search, saved] of [['?seat=B&t=stale', 'good'], ['?seat=B', 'saved']]) {
    const c = cred(search, fakeStorage({ [KEY_B]: saved }));
    assert.ok(c.hadCredentials);
    c.settle({ seat: null });
    assert.strictEqual(c.hadCredentials, true, search);
    assert.strictEqual(c.token, '');
    assert.strictEqual(c.query(), '?seat=B');
    assert.deepStrictEqual(c.body({ a: 1 }), { token: '', a: 1 });
    assert.strictEqual(c.promptLink('https://x.test'), '');
    assert.strictEqual(c.containsToken('stale saved good'), false);
  }
});

test('settle: with no token presented nothing is touched', () => {
  for (const search of ['', '?seat=B', '?preview=B', '?seat=Z&t=x']) {
    const s = fakeStorage();
    const c = cred(search, s);
    c.settle({ seat: null });
    c.settle({ seat: 'B' });
    assert.deepStrictEqual(writes(s), [], search || '(empty)');
  }
  // a link with a token but no seat has no key to save under
  const s = fakeStorage();
  cred('?t=tok', s).settle({ seat: null });
  assert.deepStrictEqual(writes(s), []);
});

test('settle: a missing or odd room view does nothing', () => {
  for (const R of [null, undefined, 'x', 3]) {
    const s = fakeStorage({ [KEY_B]: 'saved' });
    cred('?seat=B', s).settle(R);
    assert.deepStrictEqual(writes(s), [], String(R));
  }
});

test('remember: saves the link\'s token, and nothing for a token that did not come from the link', () => {
  const s = fakeStorage();
  cred('?seat=A&t=ta', s).remember();
  assert.deepStrictEqual(s.data, { 'behalf.seat.abc123.A': 'ta' });
  const s2 = fakeStorage({ [KEY_B]: 'saved' });
  cred('?seat=B', s2).remember();
  assert.deepStrictEqual(writes(s2), []);
});

test('credentials leave the invite keys alone and write only behalf.seat. keys', () => {
  const s = fakeStorage({ [L.INVITE_KEY_PREFIX + 'abc123']: '{}' });
  cred('?seat=B&t=url', s).settle({ seat: 'B' });
  assert.ok(Object.keys(s.data).every((k) => k === L.INVITE_KEY_PREFIX + 'abc123' || k.startsWith('behalf.seat.')));
  assert.strictEqual(s.data[L.INVITE_KEY_PREFIX + 'abc123'], '{}');
});

// ---------- path and link builders ----------
test('seatFromSearch: A or B, else null', () => {
  assert.strictEqual(L.seatFromSearch('?seat=A'), 'A');
  assert.strictEqual(L.seatFromSearch('?seat=B&t=x'), 'B');
  assert.strictEqual(L.seatFromSearch('seat=B'), 'B', 'without the question mark');
  assert.strictEqual(L.seatFromSearch('?seat=A&seat=B'), 'A', 'the first one counts');
  for (const bad of ['', '?seat=', '?seat=C', '?seat=a', '?seat=AB', '?x=A', undefined, null, 5]) {
    assert.strictEqual(L.seatFromSearch(bad), null, String(bad));
  }
});

test('roomPath: the room page with the seat (wording and tab key), never a token', () => {
  assert.strictEqual(L.roomPath('abc123', 'A'), '/room/abc123?seat=A');
  assert.strictEqual(L.roomPath('abc123', 'B'), '/room/abc123?seat=B');
  for (const seat of [null, undefined, '', 'C', 'a', 'A&t=x', '?seat=A']) assert.strictEqual(L.roomPath('abc123', seat), '/room/abc123', String(seat));
  assert.strictEqual(L.roomPath('a b/c', 'A'), '/room/a%20b%2Fc?seat=A', 'the id is encoded');
  assert.strictEqual(L.roomPath('abc123'), '/room/abc123');
  for (const id of [null, undefined, '', 5, {}]) assert.strictEqual(L.roomPath(id, 'A'), null, String(id));
  assert.strictEqual(L.roomPath.length, 2, 'takes an id and a seat, and nothing else');
});

test('briefPath: the agreement page with the seat only, never a token', () => {
  assert.strictEqual(L.briefPath('abc123', 'A'), '/brief/abc123?seat=A');
  assert.strictEqual(L.briefPath('abc123', null), '/brief/abc123');
  assert.strictEqual(L.briefPath('abc123', 'Z'), '/brief/abc123');
  assert.strictEqual(L.briefPath('a b', 'B'), '/brief/a%20b?seat=B');
  assert.strictEqual(L.briefPath(null, 'A'), null);
  assert.strictEqual(L.briefPath.length, 2);
});

test('previewPath: /room/ID?preview=SEAT, no token, null for no id or a seat that is not A or B', () => {
  assert.strictEqual(L.previewPath('abc123', 'B'), '/room/abc123?preview=B');
  assert.strictEqual(L.previewPath('a/b', 'A'), '/room/a%2Fb?preview=A');
  for (const seat of [null, undefined, '', 'C', 'B&t=x']) assert.strictEqual(L.previewPath('abc123', seat), null, String(seat));
  for (const id of [null, undefined, '', 5]) assert.strictEqual(L.previewPath(id, 'B'), null, String(id));
  assert.strictEqual(L.previewPath.length, 2);
});

test('the builders that carry no token take none', () => {
  // An extra argument is ignored, so a token can't be passed to them by mistake.
  assert.strictEqual(L.roomPath('abc123', 'A', 'tok'), '/room/abc123?seat=A');
  assert.strictEqual(L.briefPath('abc123', 'A', 'tok'), '/brief/abc123?seat=A');
  assert.strictEqual(L.previewPath('abc123', 'B', 'tok'), '/room/abc123?preview=B');
});

test('seatLink: a seat\'s own link with the token encoded, empty unless every part is valid', () => {
  assert.strictEqual(L.seatLink(ORIGIN, 'abc123', 'B', 'tok'), ORIGIN + '/room/abc123?seat=B&t=tok');
  assert.strictEqual(L.seatLink('', 'abc123', 'A', 'tok'), '/room/abc123?seat=A&t=tok', 'an empty origin gives a path');
  assert.strictEqual(L.seatLink(ORIGIN, 'abc123', 'B', 'a&b=c d/e'), ORIGIN + '/room/abc123?seat=B&t=a%26b%3Dc%20d%2Fe');
  assert.strictEqual(L.seatLink(undefined, 'abc123', 'B', 'tok'), '/room/abc123?seat=B&t=tok');
  for (const bad of [[ORIGIN, 'abc123', 'C', 'tok'], [ORIGIN, 'abc123', null, 'tok'], [ORIGIN, '', 'B', 'tok'], [ORIGIN, null, 'B', 'tok'], [ORIGIN, 'abc123', 'B', ''], [ORIGIN, 'abc123', 'B', null], [ORIGIN, 'abc123', 'B', 5]]) {
    assert.strictEqual(L.seatLink(...bad), '', JSON.stringify(bad));
  }
});

test('demoUrl: the demo creator\'s seat A link as a path, null unless id and token are both strings', () => {
  assert.strictEqual(L.demoUrl({ id: 'abc123', token: 'tok' }), '/room/abc123?seat=A&t=tok');
  assert.strictEqual(L.demoUrl({ id: 'a b', token: 'x&y' }), '/room/a%20b?seat=A&t=x%26y');
  assert.strictEqual(L.demoUrl({ id: 'abc123', token: 'tok', extra: 1 }), '/room/abc123?seat=A&t=tok');
  for (const bad of [null, undefined, {}, 'x', 5, { id: 'abc123' }, { token: 'tok' }, { id: 5, token: 'tok' }, { id: 'abc123', token: 5 }, { id: 'abc123', token: null }, { id: '', token: 'tok' }, { id: 'abc123', token: '' }]) {
    assert.strictEqual(L.demoUrl(bad), null, JSON.stringify(bad));
  }
});

test('tokenOf: the t parameter of a seat link, or an empty string', () => {
  assert.strictEqual(L.tokenOf('https://behalf.example/room/r1?seat=A&t=abc123'), 'abc123');
  assert.strictEqual(L.tokenOf('/room/r1?seat=A&t=abc123'), 'abc123');
  assert.strictEqual(L.tokenOf('/room/r1?seat=A'), '');
  assert.strictEqual(L.tokenOf(''), '');
  assert.strictEqual(L.tokenOf(undefined), '');
});
