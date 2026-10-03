'use strict';
// The behaviour every store backend must have. Not under test/ (node --test would run it as a file of its own): a backend's
// test file calls runStoreContract(name, makeStore) with
//   makeStore = async () => ({ store, reopen, seed, cleanup, preserved? })
//   store:     loaded and empty;
//   reopen():  settles and closes the store it opened last, then returns a new loaded store over the data as stored so far;
//   seed(doc, version): closes the current store and replaces the backend's data with doc = { rooms, usage, users, sessions,
//              agentkeys } (each optional) as stored at schema `version` (default 1); the next reopen() loads it;
//   cleanup(): awaits close() on every store it opened, then removes the data;
//   preserved(id): optional; whether the backend still holds the stored copy of a room that was skipped at load.
// Mid-life a test calls settle(); drain() and close() are terminal and only used at the end.
// persist() with an unknown kind is a programmer error: a backend may throw at once or return a rejected promise, so the
// contract accepts either. Every other persist() failure resolves false.
const test = require('node:test');
const assert = require('node:assert/strict');
const { KINDS } = require('../lib/store-core');

const minimalRoom = (id) => ({ id, seats: { A: { mode: 'builtin', token: 't' + id + 'a' }, B: { mode: 'builtin', token: 't' + id + 'b' } }, ledger: [], envelopes: [], claims: {}, demo: false });
const plain = (v) => JSON.parse(JSON.stringify(v));

// A logger that records: every line as { level, event, fields, err }, with helpers to ask what was logged.
function capture() {
  const lines = [];
  const mk = (level) => (event, fields, err) => lines.push({ level, event, fields: fields || {}, err });
  return { lines, info: mk('info'), warn: mk('warn'), error: mk('error'), events: () => lines.map((l) => l.event), has: (event) => lines.some((l) => l.event === event) };
}

function runStoreContract(name, makeStore) {
  // Each case gets a fresh store and cleans up after itself.
  const it = (title, fn) => test(`${name} contract: ${title}`, async (t) => {
    const h = await makeStore();
    t.after(async () => { await h.store.close(); await h.cleanup(); });
    await fn(h);
  });

  it('rooms save and reload', async ({ store, reopen }) => {
    const r = minimalRoom('room0001');
    r.note = 'hello';
    r.running = true; // never persisted
    store.state.rooms.set('room0001', r);
    store.state.rooms.set('room0002', minimalRoom('room0002'));
    store.save('room0001');
    store.save('room0002');
    assert.equal(await store.settle(), true);
    const s2 = await reopen();
    assert.deepEqual([...s2.state.rooms.keys()].sort(), ['room0001', 'room0002']);
    assert.equal(s2.state.rooms.get('room0001').note, 'hello');
    assert.equal('running' in s2.state.rooms.get('room0001'), false);
  });

  it('a delete (eviction) persists', async ({ store, reopen }) => {
    store.state.rooms.set('room0001', minimalRoom('room0001'));
    store.state.rooms.set('room0002', minimalRoom('room0002'));
    store.save();
    assert.equal(await store.settle(), true);
    store.state.rooms.delete('room0001');
    store.save('room0001');
    assert.equal(await store.settle(), true);
    const s2 = await reopen();
    assert.deepEqual([...s2.state.rooms.keys()], ['room0002']);
  });

  it('a room deleted from the map, then save() with no id, is gone after reopen', async ({ store, reopen }) => {
    store.state.rooms.set('room0001', minimalRoom('room0001'));
    store.state.rooms.set('room0002', minimalRoom('room0002'));
    store.save();
    assert.equal(await store.settle(), true);
    store.state.rooms.delete('room0001');
    store.save();
    assert.equal(await store.settle(), true);
    assert.deepEqual([...(await reopen()).state.rooms.keys()], ['room0002']);
  });

  it('usage, including byUser, round-trips; resetUsage clears the counters and persists', async ({ store, reopen }) => {
    const u = store.state.usage;
    u.day = '2026-10-03'; u.total = 5;
    u.byIp['1.2.3.4'] = 2; u.failedByIp['5.6.7.8'] = 1; u.byUser['42'] = 3;
    store.saveUsage();
    assert.equal(await store.settle(), true);
    const s2 = await reopen();
    assert.deepEqual(plain(s2.state.usage), { day: '2026-10-03', total: 5, byIp: { '1.2.3.4': 2 }, failedByIp: { '5.6.7.8': 1 }, byUser: { 42: 3 } });
    assert.equal(Object.getPrototypeOf(s2.state.usage.byUser), null);
    s2.resetUsage('2026-10-04');
    assert.equal(await s2.settle(), true); // resetUsage schedules its own save
    const s3 = await reopen();
    assert.deepEqual(plain(s3.state.usage), { day: '2026-10-04', total: 0, byIp: {}, failedByIp: {}, byUser: {} });
  });

  it('resetUsage reaches the backend without any other save', async ({ store, reopen }) => {
    store.state.usage.day = 'old'; store.state.usage.total = 2; store.state.usage.byUser.x = 2;
    store.saveUsage();
    assert.equal(await store.settle(), true);
    store.resetUsage('new');
    assert.equal(await store.settle(), true);
    const s2 = await reopen();
    assert.deepEqual(plain(s2.state.usage), { day: 'new', total: 0, byIp: {}, failedByIp: {}, byUser: {} });
  });

  for (const kind of KINDS) {
    it(`collection ${kind}: round-trip, delete persists, map identity is stable`, async ({ store, reopen }) => {
      const c = store.collection(kind);
      assert.equal(store.collection(kind).map, c.map, 'the same map every call');
      c.map.set('a1', { userId: '1', n: 1 });
      c.map.set('b2', { userId: '2', n: 2 });
      c.save('a1');
      c.save('b2');
      assert.equal(await store.settle(), true);
      const s2 = await reopen();
      const c2 = s2.collection(kind);
      assert.deepEqual(plain(Object.fromEntries(c2.map)), { a1: { userId: '1', n: 1 }, b2: { userId: '2', n: 2 } });
      assert.equal(s2.collection(kind).map, c2.map);
      c2.map.delete('a1');
      c2.save('a1');
      assert.equal(await s2.settle(), true);
      const s3 = await reopen();
      assert.deepEqual([...s3.collection(kind).map.keys()], ['b2']);
    });

    it(`collection ${kind}: a record deleted from the map, then save() with no id, is gone after reopen`, async ({ store, reopen }) => {
      const c = store.collection(kind);
      c.map.set('a1', { n: 1 });
      c.map.set('b2', { n: 2 });
      c.save();
      assert.equal(await store.settle(), true);
      c.map.delete('a1');
      c.save();
      assert.equal(await store.settle(), true);
      assert.deepEqual([...(await reopen()).collection(kind).map.keys()], ['b2']);
    });
  }

  for (const kind of KINDS) {
    it(`collection ${kind}: an in-place change, then save() with no id, reaches the backend`, async ({ store, reopen }) => {
      const c = store.collection(kind);
      c.map.set('a1', { n: 1 });
      c.save();
      assert.equal(await store.settle(), true);
      c.map.get('a1').n = 2;
      c.save();
      assert.equal(await store.settle(), true);
      assert.equal((await reopen()).collection(kind).map.get('a1').n, 2);
    });
  }

  it('persist(kind, id) makes that record durable and nothing else: only the named id is marked', async ({ store, reopen }) => {
    store.state.rooms.set('room0001', minimalRoom('room0001'));
    store.state.rooms.set('room0002', minimalRoom('room0002'));
    store.save();
    assert.equal(await store.settle(), true);
    store.state.rooms.get('room0001').note = 'one';
    store.state.rooms.get('room0002').note = 'two'; // changed in place, never marked
    assert.equal(await store.persist('room', 'room0001'), true);
    const s2 = await reopen();
    assert.equal(s2.state.rooms.get('room0001').note, 'one');
    assert.equal(s2.state.rooms.get('room0002').note, undefined);
  });

  it('collections do not mix: a record of one kind is not seen under another', async ({ store, reopen }) => {
    store.collection('user').map.set('same', { x: 1 });
    store.collection('user').save('same');
    assert.equal(await store.settle(), true);
    const s2 = await reopen();
    assert.equal(s2.collection('user').map.size, 1);
    assert.equal(s2.collection('session').map.size, 0);
    assert.equal(s2.collection('agentkey').map.size, 0);
  });

  it("collection('room') is the rooms map, and save(id) is its alias", async ({ store, reopen }) => {
    const c = store.collection('room');
    assert.equal(c.map, store.state.rooms);
    c.map.set('room0001', minimalRoom('room0001'));
    store.save('room0002'); // an alias for c.save, and a no-op for an id with no room
    c.save('room0001');
    assert.equal(await store.settle(), true);
    assert.deepEqual([...(await reopen()).state.rooms.keys()], ['room0001']);
  });

  it('an unknown collection kind throws', async ({ store }) => {
    for (const k of ['usage', 'users', '__proto__', 'constructor', undefined, '']) assert.throws(() => store.collection(k), Error, String(k));
  });

  it('a non-string key in a collection does not corrupt the store: it stays loadable and the other records survive', async ({ store, reopen }) => {
    const c = store.collection('user');
    c.map.set(42, { id: 42 });
    c.map.set('ok1', { id: 'ok1' });
    c.save();
    store.state.rooms.set('room0001', minimalRoom('room0001'));
    store.save('room0001');
    assert.equal(await store.settle(), true);
    const s2 = await reopen(); // would throw or start empty if the file were invalid
    assert.deepEqual([...s2.collection('user').map.keys()], ['ok1']);
    assert.ok(s2.state.rooms.has('room0001'));
  });

  it('two settle() calls with a change and a save(id) between them both resolve, and the newer state is what is stored', async ({ store, reopen }) => {
    const r = minimalRoom('room0001');
    r.note = 'old';
    store.state.rooms.set('room0001', r);
    store.save('room0001');
    const first = store.settle();
    r.note = 'new';
    store.save('room0001');
    const second = store.settle();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal((await reopen()).state.rooms.get('room0001').note, 'new');
  });

  it('timer-triggered writes racing a settle(): the newest state is durable', async ({ store, reopen }) => {
    const r = minimalRoom('room0001');
    store.state.rooms.set('room0001', r);
    for (let i = 1; i <= 4; i++) {
      r.note = 'n' + i;
      store.save('room0001');
      await new Promise((res) => setTimeout(res, 15)); // lands around a debounce expiry or a write in flight
    }
    r.note = 'last';
    store.save('room0001');
    assert.equal(await store.settle(), true);
    assert.equal((await reopen()).state.rooms.get('room0001').note, 'last');
  });

  it('settle() writes and resolves true; the data is durable once it has', async ({ store, reopen }) => {
    store.state.rooms.set('room0001', minimalRoom('room0001'));
    store.save('room0001');
    assert.equal(await store.settle(), true);
    assert.ok((await reopen()).state.rooms.has('room0001'));
  });

  it('drain() is terminal: it resolves true with the data durable, and persist() then resolves false', async ({ store, reopen }) => {
    store.state.rooms.set('room0001', minimalRoom('room0001'));
    store.save('room0001');
    assert.equal(await store.drain(), true);
    assert.equal(await store.persist('room', 'room0001'), false);
    assert.ok((await reopen()).state.rooms.has('room0001'));
  });

  it('persist() is durable when it resolves true', async ({ store, reopen }) => {
    const c = store.collection('session');
    c.map.set('s1', { userId: '1' });
    c.save('s1');
    assert.equal(await store.persist('session', 's1'), true);
    const s2 = await reopen();
    assert.ok(s2.collection('session').map.has('s1'));
    s2.collection('session').map.delete('s1'); // a revocation
    assert.equal(await s2.persist('session', 's1'), true);
    assert.equal((await reopen()).collection('session').map.size, 0);
  });

  it('persist() with an unknown kind throws or rejects; a record that cannot be serialised resolves false', async ({ store }) => {
    await assert.rejects(async () => store.persist('nope', 'x'), /unknown collection kind/);
    await assert.rejects(async () => store.persist('nope'), /unknown collection kind/);
    const c = store.collection('session');
    c.map.set('bad', { n: 1n }); // JSON.stringify throws
    c.save('bad');
    assert.equal(await store.persist('session', 'bad'), false);
  });

  it('health() is ok on a healthy store, and kind names the backend', async ({ store }) => {
    assert.deepEqual(store.health(), { ok: true, failingSince: null });
    assert.equal(typeof store.kind, 'string');
    store.save();
    await store.settle();
    assert.deepEqual(store.health(), { ok: true, failingSince: null });
  });

  it('a room holding a NUL and a lone surrogate round-trips exactly', async ({ store, reopen }) => {
    const r = minimalRoom('weird001');
    r.topic = 'a\u0000b';
    r.note = 'x\ud83dy';
    r.seats.A.draftText = '\u0000😀\ud83d';
    store.state.rooms.set('weird001', r);
    store.save('weird001');
    assert.equal(await store.settle(), true);
    const back = (await reopen()).state.rooms.get('weird001');
    assert.equal(back.topic, 'a\u0000b');
    assert.equal(back.note, 'x\ud83dy');
    assert.equal(back.seats.A.draftText, '\u0000😀\ud83d');
  });

  it('a record that throws keeps its last good copy and the others still save', async ({ store, reopen }) => {
    const r = minimalRoom('room0001');
    r.note = 'good';
    store.state.rooms.set('room0001', r);
    store.state.rooms.set('room0002', minimalRoom('room0002'));
    store.save();
    assert.equal(await store.settle(), true);
    r.note = 1n; // JSON.stringify throws
    store.state.rooms.get('room0002').note = 'changed';
    store.save('room0001');
    store.save('room0002');
    assert.equal(await store.settle(), true);
    const s2 = await reopen();
    assert.equal(s2.state.rooms.get('room0001').note, 'good');
    assert.equal(s2.state.rooms.get('room0002').note, 'changed');
  });

  it('an in-place change to the usage with no saveUsage() reaches the backend with the next write', async ({ store, reopen }) => {
    assert.equal(await store.settle(), true);
    store.state.usage.byUser.u1 = 5;
    store.state.rooms.set('room0001', minimalRoom('room0001'));
    store.save('room0001');
    assert.equal(await store.settle(), true);
    assert.deepEqual(plain((await reopen()).state.usage.byUser), { u1: 5 });
  });

  it('an in-place change to a loaded room, with no save(id), reaches the backend on the first write after load', async ({ store, seed, reopen }) => {
    await seed({ rooms: { room0001: minimalRoom('room0001'), room0002: minimalRoom('room0002') } });
    const s2 = await reopen();
    s2.state.rooms.get('room0001').status = 'paused'; // what hydrate() does: no save() for it
    s2.state.rooms.set('room0003', minimalRoom('room0003'));
    s2.save('room0003'); // only the new room is named
    assert.equal(await s2.settle(), true);
    assert.equal((await reopen()).state.rooms.get('room0001').status, 'paused');
  });

  it('seeded data loads: the v0 to v1 migration is applied, usage and collections come through', async ({ store, seed, reopen }) => {
    const old = minimalRoom('old00001');
    delete old.seats.A.mode;
    old.demo = 'yes';
    await seed({
      rooms: { old00001: old },
      usage: { day: 'd', total: 2, byIp: { x: 2 }, byUser: { u: 1 } },
      users: { 1: { id: '1' } }, sessions: { s: { userId: '1' } }, agentkeys: { k: { userId: '1' } },
    }, 0);
    const s2 = await reopen();
    assert.equal(s2.state.rooms.get('old00001').seats.A.mode, 'builtin');
    assert.equal(s2.state.rooms.get('old00001').demo, false);
    assert.deepEqual(plain(s2.state.usage), { day: 'd', total: 2, byIp: { x: 2 }, failedByIp: {}, byUser: { u: 1 } });
    assert.deepEqual([...s2.collection('user').map.keys(), ...s2.collection('session').map.keys(), ...s2.collection('agentkey').map.keys()], ['1', 's', 'k']);
  });

  it('a seeded room that fails to load is reported by isSkipped and is not written over by a later save', async ({ store, seed, reopen, preserved }) => {
    const bad = minimalRoom('bad00001');
    delete bad.claims;
    await seed({ rooms: { good0001: minimalRoom('good0001'), bad00001: bad } });
    const s2 = await reopen();
    assert.equal(s2.isSkipped('room', 'bad00001'), true);
    assert.equal(s2.isSkipped('room', 'good0001'), false);
    assert.equal(s2.state.rooms.has('bad00001'), false);
    s2.state.rooms.set('room0003', minimalRoom('room0003'));
    s2.save();
    assert.equal(await s2.settle(), true);
    assert.equal(s2.isSkipped('room', 'bad00001'), true);
    assert.equal(s2.state.rooms.has('bad00001'), false);
    if (preserved) assert.equal(await preserved('bad00001'), true, 'the stored copy of the skipped room is still held');
  });
}

module.exports = { runStoreContract, minimalRoom, plain, capture };
