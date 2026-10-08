'use strict';
// Item 5, the server side: inviting the other person by email. The domain op (reserveInvite), the usage counters, the notices
// (lib/notices.js sendInvite, inviteAllowed) and the route POST /api/rooms/:id/seats/A/invite, in-process over real HTTP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createNotices, INVITE_SUBJECT, INVITES_PER_ADDRESS } = require('../lib/notices');
const { createApp } = require('../lib/app');
const { createStore } = require('../lib/store');
const { KIND, emptyUsage } = require('../lib/store-core');
const { loadConfig, loadSecrets } = require('../lib/config');
const { createLog } = require('../lib/log');
const { TAGS } = require('../lib/mail');
const { mkTmp, rmTmp } = require('../test-support/server');

const T = { timeout: 30000 };
const PUBLIC = 'https://behalf.test';
const OAUTH = '__Host-behalf_oauth';
const SESSION = '__Host-behalf_session';
const USERS = { 1001: 'octocat', 1002: 'other-user', 1003: 'the-admin' };
const ADMIN = '1003';
const DAY = 24 * 60 * 60 * 1000;
const SOMEONE = 'someone@example.com';
const MARKER = 'LEAK-MARKER';

const capture = () => { const out = []; return { out, log: createLog({ stream: { write: (s) => out.push(s) } }) }; };
const mkClock = (t = 1700000000000) => { const c = { t, now: () => c.t }; return c; };

// A mailer that records what it is asked to send. `up` is whether it can send at all (mailer.available()).
function fakeMailer({ up = true, send } = {}) {
  const m = {
    sent: [], up, kind: 'fake', outbox: null, start() {}, close() {},
    status: () => (m.up ? 'ready' : 'failed'), available: () => m.up,
    sendMail: (msg) => { m.sent.push(msg); return send ? send(msg) : Promise.resolve({ status: 'sent', attempts: 1 }); },
  };
  return m;
}

// ---------- the notices on their own ----------
function mkNotices({ deliverable = () => true, send, clock = mkClock() } = {}) {
  const mailer = fakeMailer({ send });
  const { out, log } = capture();
  const notices = createNotices({ mailer, deliverable, adminEmail: null, publicUrl: PUBLIC, clock, log });
  return { notices, mailer, out, clock };
}
const LINK = `${PUBLIC}/room/abc123?seat=B&t=TOKENB`;

test('sendInvite: a fixed subject and the invite tag, the link, who sent it, no replyTo, and the closing line', () => {
  const { notices, mailer } = mkNotices();
  notices.sendInvite({ to: SOMEONE, login: 'octo-cat', link: LINK });
  assert.equal(mailer.sent.length, 1);
  const m = mailer.sent[0];
  assert.equal(m.to, SOMEONE);
  assert.equal(m.subject, "You're invited to work out an agreement on Behalf");
  assert.equal(m.subject, INVITE_SUBJECT);
  assert.equal(m.tag, 'invite');
  assert.ok(TAGS.includes(m.tag));
  assert.ok(!('replyTo' in m) && !('toName' in m) && !('fromName' in m), 'no reply address and no names');
  assert.ok(m.text.startsWith(`A GitHub user, @octo-cat, invited you to work out an agreement on Behalf. Your private link: ${LINK}`));
  assert.ok(m.text.includes("If you didn't expect this, you can ignore it."));
  const linkHtml = LINK.replace(/&/g, '&amp;');
  assert.ok(m.html.includes(`<a href="${linkHtml}">${linkHtml}</a>`), 'the ampersand is escaped');
  assert.ok(m.html.includes('<a href="https://github.com/octo-cat">@octo-cat</a>'));
});

test('sendInvite: a login that is not a GitHub login is left out ("Someone"), and the link is escaped in the HTML', () => {
  const { notices, mailer } = mkNotices();
  for (const bad of ['<script>alert(1)</script>', 'a b', 'a_b', '', undefined, null, 5, {}, 'x'.repeat(60)]) {
    notices.sendInvite({ to: SOMEONE, login: bad, link: `${PUBLIC}/room/a?seat=B&t=<b>` });
  }
  assert.equal(mailer.sent.length, 9);
  for (const m of mailer.sent) {
    assert.ok(m.text.startsWith('Someone invited you to work out an agreement on Behalf.'), m.text.slice(0, 40));
    assert.ok(!m.text.includes('A GitHub user') && !m.html.includes('github.com'));
    assert.ok(!m.html.includes('<script>') && !m.html.includes('<b>'), 'escaped');
    assert.ok(m.html.includes('&lt;b&gt;'));
  }
});

test('sendInvite: a send that throws or rejects is logged without a field and goes no further', async () => {
  for (const send of [() => { throw new Error(`boom ${SOMEONE}`); }, () => Promise.reject(new Error(`boom ${SOMEONE}`))]) {
    const { notices, out } = mkNotices({ send });
    assert.doesNotThrow(() => notices.sendInvite({ to: SOMEONE, login: 'octocat', link: LINK }));
    await new Promise((r) => setImmediate(r));
    assert.equal(out.length, 1);
    assert.match(out[0], /mail\.notice_failed/);
    assert.ok(!out[0].includes('example.com'), 'no address, and no error message, in the log');
  }
});

test('sendInvite: mail that stopped being deliverable is not sent, and says so once; the slot is spent', () => {
  let up = true;
  const { notices, mailer, out } = mkNotices({ deliverable: () => up });
  up = false;
  for (let i = 0; i < 2; i++) notices.sendInvite({ to: SOMEONE, login: 'octocat', link: LINK });
  assert.equal(mailer.sent.length, 0);
  assert.equal(out.filter((l) => /mail\.notice_skipped/.test(l)).length, 1, 'logged once');
  assert.ok(!out.join('').includes('example.com'));
  assert.equal(notices.inviteAllowed(SOMEONE), true, 'two of three spent');
  notices.sendInvite({ to: SOMEONE, login: 'octocat', link: LINK });
  assert.equal(notices.inviteAllowed(SOMEONE), false, 'nothing is refunded');
  up = true;
  notices.sendInvite({ to: 'b@example.com', login: 'octocat', link: LINK });
  assert.equal(mailer.sent.length, 1);
  up = false;
  notices.sendInvite({ to: 'c@example.com', login: 'octocat', link: LINK });
  assert.equal(out.filter((l) => /mail\.notice_skipped/.test(l)).length, 2, 'logged again after a send');
});

test('inviteAllowed: 3 a day per address whatever its case, other addresses are unaffected, and the day passes', () => {
  const { notices, clock } = mkNotices();
  assert.equal(INVITES_PER_ADDRESS, 3);
  for (const to of [SOMEONE, 'SomeOne@Example.com', 'SOMEONE@EXAMPLE.COM']) {
    assert.equal(notices.inviteAllowed(to), true);
    notices.sendInvite({ to, login: 'octocat', link: LINK });
  }
  assert.equal(notices.inviteAllowed('someone@example.com'), false);
  assert.equal(notices.inviteAllowed('SOMEONE@example.com'), false);
  assert.equal(notices.inviteAllowed('else@example.com'), true);
  assert.equal(notices.inviteAllowed(SOMEONE), false, 'asking counts nothing');
  clock.t += DAY - 1;
  assert.equal(notices.inviteAllowed(SOMEONE), false);
  clock.t += 1;
  assert.equal(notices.inviteAllowed(SOMEONE), true);
});

test('the per-address table holds no address: it is keyed by a keyed hash that differs per process', () => {
  const a = mkNotices();
  const b = mkNotices();
  a.notices.sendInvite({ to: SOMEONE, login: 'octocat', link: LINK });
  // another instance has its own key and knows nothing of the first one's table
  assert.equal(b.notices.inviteAllowed(SOMEONE), true);
  assert.ok(!JSON.stringify(a.notices).includes('example.com'));
});

// ---------- the usage counters ----------
test('usage: the invite counters are omitted from the stored form while empty (byte-compatible), and kept once used', () => {
  const encode = KIND.usage.encode;
  const empty = emptyUsage();
  assert.equal(encode(empty), '{"day":"","total":0,"byIp":{},"failedByIp":{}}', 'the form from before accounts and invites');
  const withUsers = Object.assign(emptyUsage(), { day: 'd', total: 1, byUser: Object.assign(Object.create(null), { u1: 1 }) });
  assert.equal(encode(withUsers), '{"day":"d","total":1,"byIp":{},"failedByIp":{},"byUser":{"u1":1}}', 'the form from before invites');
  const used = Object.assign(emptyUsage(), { invitesTotal: 2, invitesByUser: Object.assign(Object.create(null), { u1: 2 }) });
  assert.equal(encode(used), '{"day":"","total":0,"byIp":{},"failedByIp":{},"invitesByUser":{"u1":2},"invitesTotal":2}');
  const back = KIND.usage.load(JSON.parse(encode(used)));
  assert.equal(back.invitesTotal, 2);
  assert.deepEqual(Object.assign({}, back.invitesByUser), { u1: 2 });
  assert.equal(Object.getPrototypeOf(back.invitesByUser), null);
});

test('usage: a stored usage from before invites loads with empty counters; damaged counters are dropped', () => {
  const old = KIND.usage.load({ day: 'd', total: 1, byIp: {}, failedByIp: {} });
  assert.equal(old.invitesTotal, 0);
  assert.deepEqual(Object.assign({}, old.invitesByUser), {});
  for (const bad of [-1, 'x', null, NaN, {}, []]) assert.equal(KIND.usage.load({ day: 'd', total: 0, invitesTotal: bad }).invitesTotal, 0, String(bad));
  const mixed = KIND.usage.load({ day: 'd', total: 0, invitesByUser: { __proto__: 1, ok: 3, neg: -1, str: 'x' } });
  assert.deepEqual(Object.assign({}, mixed.invitesByUser), { ok: 3 });
});

// ---------- the app ----------
function fakeGithub() {
  const gh = { id: 1001, login: 'octocat', challenge: null };
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  gh.fetch = async (url, init = {}) => {
    if (String(url) === 'https://github.com/login/oauth/access_token') {
      const b = JSON.parse(init.body);
      const pkce = crypto.createHash('sha256').update(String(b.code_verifier)).digest('base64url') === gh.challenge;
      return pkce ? json({ access_token: 'gho_X', token_type: 'bearer', scope: '' }) : json({ error: 'bad_verification_code' });
    }
    return json({ id: gh.id, login: gh.login });
  };
  return gh;
}

function request(base, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, cookies: res.headers['set-cookie'] || [], text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const cookieValue = (res, name) => {
  const line = res.cookies.find((c) => c.startsWith(name + '='));
  return line === undefined ? null : line.slice(name.length + 1).split(';')[0];
};

// The config is smtp by default, so mailCanReach holds and the fake mailer's `up` decides whether mail is deliverable. A dev transport
// counts as readable only off the platform and on a local PUBLIC_URL (config.devOutbox): pass env to say otherwise.
// `file` keeps the store on disk (for a restart); `mailer` is shared by two boots of the same store.
async function boot(t, { signin = 'github', env = {}, mailer = fakeMailer(), dir, listen = true } = {}) {
  const own = !dir;
  if (own) dir = mkTmp('invite-');
  const { out, log } = capture();
  const config = loadConfig({
    SIGNIN: signin, PUBLIC_URL: PUBLIC, GITHUB_BLOCKED_IDS: '666', ADMIN_GITHUB_IDS: ADMIN,
    MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', MAIL_FROM: 'Behalf <invites@example.com>',
    PER_IP_DAILY: '1000', PER_USER_DAILY: '1000', DAILY_ROOM_LIMIT: '1000', ...env,
  });
  const store = createStore({ file: path.join(dir, 'data', 'rooms.json'), log });
  store.load();
  const clock = mkClock(Date.now());
  const gh = fakeGithub();
  const proxy = { live: () => false, MODEL: 'fake' };
  const app = createApp({
    config, secrets: loadSecrets({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', SMTP_USER: 'u', SMTP_PASS: 'p' }), log, store, proxy, mailer,
    clock: { sleep: async () => {}, now: clock.now }, fetch: gh.fetch,
  });
  let root = null;
  if (listen) {
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    root = `http://127.0.0.1:${app.server.address().port}`;
  }
  const h = { app, store, gh, out, clock, mailer, dir, config };
  h.stop = async () => { app.domain.stop(); assert.equal(await store.settle(), true); await store.close(); };
  let stopped = false;
  t.after(async () => {
    if (!stopped) await app.drain().catch(() => {});
    if (app.server.closeAllConnections) app.server.closeAllConnections();
    app.close();
    if (own) rmTmp(dir);
  });
  h.stopForRestart = async () => { stopped = true; await h.stop(); };
  h.req = (method, p, o) => request(root, method, p, o);
  h.post = (p, { origin = PUBLIC, cookie, type = 'application/json', body = {}, headers = {} } = {}) => {
    const hd = { ...headers };
    if (origin !== null) hd.origin = origin;
    if (cookie) hd.cookie = cookie;
    if (type !== null) hd['content-type'] = type;
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    hd['content-length'] = Buffer.byteLength(payload);
    return h.req('POST', p, { headers: hd, body: payload });
  };
  h.signIn = async (id) => {
    gh.id = Number(id);
    gh.login = USERS[id];
    const begin = await h.req('GET', '/auth/github');
    const loc = new URL(begin.headers.location);
    gh.challenge = loc.searchParams.get('code_challenge');
    const cb = await h.req('GET', `/auth/github/callback?code=c&state=${encodeURIComponent(loc.searchParams.get('state'))}`, { headers: { cookie: `${OAUTH}=${cookieValue(begin, OAUTH)}` } });
    const session = cookieValue(cb, SESSION);
    assert.ok(session, 'signed in as ' + id);
    return `${SESSION}=${session}`;
  };
  return h;
}

const roomBody = { topic: `Topic ${MARKER}`, nameA: `Ann ${MARKER}`, nameB: `Ben ${MARKER}`, modeA: 'external', modeB: 'external' };
// A live room opened over HTTP by the signed-in cookie: its id and the two seat tokens.
async function openRoom(h, cookie) {
  const r = await h.post('/api/rooms', { cookie, body: roomBody });
  assert.equal(r.status, 201, r.text);
  const token = (seat) => new URL(r.json.links[seat], PUBLIC).searchParams.get('t');
  return { id: r.json.id, A: token('A'), B: token('B') };
}
const invite = (h, cookie, room, email, extra = {}) => h.post(`/api/rooms/${room.id}/seats/${extra.seat || 'A'}/invite`, { cookie, ...extra.opts, body: { token: room.A, email, ...extra.body } });
const addr = (i) => `person${i}@example.com`;
const codeOf = (r) => (r.json || {}).code;

test('/api/config: invite is true with sign-in on and mail that can reach a person, and false otherwise', T, async (t) => {
  const on = await boot(t);
  assert.equal((await on.req('GET', '/api/config')).json.invite, true);
  on.mailer.up = false;
  assert.equal((await on.req('GET', '/api/config')).json.invite, false, 'followed at each call: the mailer can turn itself off');
  const off = await boot(t, { signin: 'off' });
  assert.equal((await off.req('GET', '/api/config')).json.invite, false);
  // The dev transport is readable only off the platform and on a local PUBLIC_URL: on the platform, or with a public PUBLIC_URL (a
  // self-hosted deploy with no DROP_DATA_DIR), it writes where nobody reads, so nothing is deliverable though the mailer is up.
  const platform = await boot(t, { env: { MAIL_TRANSPORT: 'dev', DROP_DATA_DIR: path.join(mkTmp('invite-plat-'), 'data') } });
  assert.equal(platform.mailer.available(), true);
  assert.equal((await platform.req('GET', '/api/config')).json.invite, false);
  const local = await boot(t, { env: { MAIL_TRANSPORT: 'dev', PUBLIC_URL: 'http://localhost:3000' } });
  assert.equal(local.config.devOutbox, true);
  assert.equal((await local.req('GET', '/api/config')).json.invite, true);
  const smtp = await boot(t, { env: { DROP_DATA_DIR: path.join(mkTmp('invite-smtp-'), 'data') } });
  assert.equal((await smtp.req('GET', '/api/config')).json.invite, true);
});

test('a public self-hosted deploy (https PUBLIC_URL, no DROP_DATA_DIR, dev transport): no outbox page, no invite, mail_off and nothing counted', T, async (t) => {
  const h = await boot(t, { env: { MAIL_TRANSPORT: 'dev' } });
  assert.equal(h.config.devOutbox, false);
  assert.equal((await h.req('GET', '/api/config')).json.invite, false);
  assert.equal((await h.req('GET', '/dev/outbox')).status, 404);
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  const r = await invite(h, cookie, room, SOMEONE);
  assert.equal(r.status, 503);
  assert.equal(codeOf(r), 'mail_off');
  assert.equal(h.mailer.sent.length, 0);
  assert.equal(h.app.store.state.usage.invitesTotal, 0);
});

test('the invite: 202 queued, the email goes in the background with the seat B link and no names or topic', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  const r = await invite(h, cookie, room, `  ${SOMEONE} `);
  assert.equal(r.status, 202, r.text);
  assert.deepEqual(r.json, { status: 'queued' });
  assert.equal(h.mailer.sent.length, 1);
  const m = h.mailer.sent[0];
  assert.equal(m.to, SOMEONE);
  assert.equal(m.tag, 'invite');
  assert.equal(m.subject, INVITE_SUBJECT);
  assert.ok(m.text.includes(`${PUBLIC}/room/${room.id}?seat=B&t=${room.B}`), 'the seat B link');
  assert.ok(!m.text.includes(room.A) && !m.html.includes(room.A), 'never the seat A token');
  assert.ok(m.text.includes('@octocat'));
  for (const part of [m.text, m.html, m.subject]) {
    assert.ok(!part.includes(MARKER) && !/Ann|Ben|Topic/.test(part), 'no name and no topic');
  }
  assert.ok(!('replyTo' in m));
  const live = h.app.domain.rooms.get(room.id);
  assert.equal(live.invitesSent, 1);
  assert.equal(h.app.store.state.usage.invitesTotal, 1);
  assert.deepEqual(Object.assign({}, h.app.store.state.usage.invitesByUser), { 1001: 1 });
});

test('the answer does not wait for the send, and a send that fails or rejects is still a 202', T, async (t) => {
  let release;
  const slow = fakeMailer({ send: () => new Promise((resolve) => { release = () => resolve({ status: 'failed', code: 'X', attempts: 3 }); }) });
  const h = await boot(t, { mailer: slow });
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  const r = await invite(h, cookie, room, addr(1));
  assert.equal(r.status, 202, 'answered while the send is still pending');
  release();
  const rejecting = fakeMailer({ send: () => Promise.reject(new Error('smtp down')) });
  const g = await boot(t, { mailer: rejecting });
  const gc = await g.signIn(1001);
  const gr = await openRoom(g, gc);
  assert.equal((await invite(g, gc, gr, addr(1))).status, 202);
  await new Promise((r2) => setImmediate(r2));
  assert.ok(g.out.some((l) => /mail\.notice_failed/.test(l)));
  assert.equal(g.app.domain.rooms.get(gr.id).invitesSent, 1, 'a slot spent on a failed send stays spent');
});

test('refusals: signed out 401, wrong Origin 403, wrong content type 415, each before the body is read', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  const signedOut = await invite(h, null, room, SOMEONE);
  assert.equal(signedOut.status, 401);
  assert.equal(codeOf(signedOut), 'signin_required');
  const origin = await invite(h, cookie, room, SOMEONE, { opts: { origin: 'https://evil.test' } });
  assert.equal(origin.status, 403);
  assert.equal(codeOf(origin), 'origin');
  const type = await invite(h, cookie, room, SOMEONE, { opts: { type: 'text/plain' } });
  assert.equal(type.status, 415);
  assert.equal(codeOf(type), 'content_type');
  assert.equal(h.mailer.sent.length, 0);
  assert.equal(h.app.store.state.usage.invitesTotal, 0);
});

test('refusals: another signed-in user holding the seat A token is 403, and counts and sends nothing', T, async (t) => {
  const h = await boot(t);
  const owner = await h.signIn(1001);
  const room = await openRoom(h, owner);
  const other = await h.signIn(1002);
  const r = await invite(h, other, room, SOMEONE);
  assert.equal(r.status, 403);
  assert.equal(codeOf(r), undefined, 'no machine code');
  assert.equal(h.mailer.sent.length, 0);
  assert.equal(h.app.store.state.usage.invitesTotal, 0);
  assert.equal(h.app.domain.rooms.get(room.id).invitesSent, undefined);
  // an owner who has the wrong token, and a missing one
  assert.equal((await invite(h, owner, room, SOMEONE, { body: { token: 'nope' } })).status, 403);
  assert.equal((await invite(h, owner, room, SOMEONE, { body: { token: undefined } })).status, 400);
  assert.equal((await invite(h, owner, room, SOMEONE, { body: { token: 5 } })).status, 400);
  // the seat B token is not seat A's
  assert.equal((await invite(h, owner, room, SOMEONE, { body: { token: room.B } })).status, 403);
  assert.equal(h.mailer.sent.length, 0);
});

test('refusals: a room with no owner (opened before sign-in) is 403 even for the seat A token', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  delete h.app.domain.rooms.get(room.id).ownerId;
  assert.equal((await invite(h, cookie, room, SOMEONE)).status, 403);
  assert.equal(h.mailer.sent.length, 0);
});

test('refusals: a demo room is 404, seat B in the URL is 404, an unknown room is 404, sign-in off is 404', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const demo = (await h.post('/api/demo', { origin: null })).json;
  const asDemo = { id: demo.id, A: demo.token, B: demo.token };
  assert.equal((await invite(h, cookie, asDemo, SOMEONE)).status, 404, 'demo');
  const room = await openRoom(h, cookie);
  assert.equal((await invite(h, cookie, room, SOMEONE, { seat: 'B', body: { token: room.B } })).status, 404, 'seat B');
  assert.equal((await invite(h, cookie, room, SOMEONE, { seat: 'C' })).status, 404, 'a seat that does not exist');
  assert.equal((await invite(h, cookie, { id: 'nosuchroom', A: 'x' }, SOMEONE)).status, 404, 'unknown');
  assert.equal(h.mailer.sent.length, 0);
  assert.equal(h.app.store.state.usage.invitesTotal, 0);
  const off = await boot(t, { signin: 'off' });
  const created = (await off.post('/api/rooms', { origin: null, body: roomBody })).json;
  const offRoom = { id: created.id, A: new URL(created.links.A, PUBLIC).searchParams.get('t') };
  const r = await invite(off, null, offRoom, SOMEONE, { opts: { origin: null } });
  assert.equal(r.status, 404, 'sign-in off');
  assert.equal(off.mailer.sent.length, 0);
});

test('refusals: seat B taken (sealed, an agent, a draft, or the room has started) is 409, and counts nothing', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const card = (n) => ({ principal: { name: n }, goal: 'g', must_haves: ['m'] });
  const sealed = await openRoom(h, cookie);
  h.app.domain.sealCard(h.app.domain.rooms.get(sealed.id), 'B', card('Ben'), 'test');
  const agent = await openRoom(h, cookie);
  h.app.domain.joinAsAgent(h.app.domain.rooms.get(agent.id), 'B', 'Their agent');
  const drafted = await openRoom(h, cookie);
  h.app.domain.rooms.get(drafted.id).seats.B.drafts = 1;
  const started = await openRoom(h, cookie);
  h.app.domain.rooms.get(started.id).status = 'negotiating';
  for (const room of [sealed, agent, drafted, started]) {
    const r = await invite(h, cookie, room, SOMEONE);
    assert.equal(r.status, 409, room.id);
    assert.equal(codeOf(r), undefined);
  }
  // seat A having sealed is not "taken": the invite is for seat B
  const mine = await openRoom(h, cookie);
  h.app.domain.sealCard(h.app.domain.rooms.get(mine.id), 'A', card('Ann'), 'test');
  assert.equal((await invite(h, cookie, mine, SOMEONE)).status, 202);
  assert.equal(h.mailer.sent.length, 1);
  assert.equal(h.app.store.state.usage.invitesTotal, 1);
});

test('refusals: a bad address is 400 and counts nothing', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  for (const bad of ['', 'nope', 'a@b', 'a b@example.com', 'a@example.com\r\nBcc: x@example.com', `${'x'.repeat(250)}@example.com`, undefined, null, 5, ['a@example.com'], {}]) {
    const r = await invite(h, cookie, room, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(codeOf(r), undefined);
  }
  assert.equal(h.mailer.sent.length, 0);
  assert.equal(h.app.store.state.usage.invitesTotal, 0);
  assert.equal(h.app.domain.rooms.get(room.id).invitesSent, undefined);
});

test('a room gets 3 invitations: the fourth is 429 invite_limit, and parallel posts cannot get past it', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  for (let i = 0; i < 3; i++) assert.equal((await invite(h, cookie, room, addr(i))).status, 202);
  const r = await invite(h, cookie, room, addr(9));
  assert.equal(r.status, 429);
  assert.equal(codeOf(r), 'invite_limit');
  assert.equal(h.mailer.sent.length, 3);
  const racing = await openRoom(h, cookie);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => invite(h, cookie, racing, addr(100 + i))));
  assert.equal(results.filter((x) => x.status === 202).length, 3);
  assert.deepEqual([...new Set(results.filter((x) => x.status !== 202).map((x) => `${x.status} ${codeOf(x)}`))], ['429 invite_limit']);
  assert.equal(h.app.domain.rooms.get(racing.id).invitesSent, 3);
});

test('a user gets 10 a day: the eleventh is 429 invite_daily_limit, parallel posts cannot get past it, and the day gives them back', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const rooms = [];
  for (let i = 0; i < 5; i++) rooms.push(await openRoom(h, cookie));
  const results = await Promise.all(rooms.flatMap((room, i) => [0, 1, 2, 3, 4].map((j) => invite(h, cookie, room, addr(i * 10 + j)))));
  assert.equal(results.filter((x) => x.status === 202).length, 10);
  assert.deepEqual([...new Set(results.filter((x) => x.status !== 202).map((x) => `${x.status} ${codeOf(x)}`))].sort(), ['429 invite_daily_limit', '429 invite_limit']);
  assert.equal(h.app.store.state.usage.invitesByUser['1001'], 10);
  assert.equal(h.app.store.state.usage.invitesTotal, 10);
  assert.equal(h.mailer.sent.length, 10);
  // a room that still has a slot left is refused by the day's limit now
  const fresh = await openRoom(h, cookie);
  const r = await invite(h, cookie, fresh, addr(900));
  assert.equal(r.status, 429);
  assert.equal(codeOf(r), 'invite_daily_limit');
  assert.equal(h.app.domain.rooms.get(fresh.id).invitesSent, undefined, 'nothing counted on the room');
  // somebody else is not affected
  const other = await h.signIn(1002);
  const theirs = await openRoom(h, other);
  assert.equal((await invite(h, other, theirs, addr(901))).status, 202);
  h.clock.t += 2 * DAY;
  assert.equal((await invite(h, cookie, fresh, addr(902))).status, 202, 'a new day');
  assert.equal(h.app.store.state.usage.invitesByUser['1001'], 1);
});

test('50 a day across all users: the next user is 429 invite_daily_limit, and an admin or a granted user is exempt and not counted', T, async (t) => {
  const h = await boot(t, { listen: false });
  const d = h.app.domain;
  const open = (id) => d.createLiveRoom('203.0.113.1', { topic: 'T', modeA: 'external', modeB: 'external' }, { id, login: 'octocat' });
  const grantRecord = { status: 'granted', note: '', requestedAt: null, decidedAt: 1 };
  h.app.store.collection('aiaccess').map.set('granted', grantRecord);
  const users = ['u1', 'u2', 'u3', 'u4', 'u5'];
  for (const u of users) {
    for (let i = 0; i < 4; i++) {
      const room = open(u);
      for (let j = 0; j < (i === 3 ? 1 : 3); j++) assert.match(d.reserveInvite(room, 'A', { id: u, login: 'octocat' }), /seat=B/);
    }
  }
  assert.equal(h.app.store.state.usage.invitesTotal, 50);
  const refused = (e) => e.code === 429 && e.apiCode === 'invite_daily_limit';
  assert.throws(() => d.reserveInvite(open('u6'), 'A', { id: 'u6', login: 'octocat' }), refused);
  assert.equal(h.app.store.state.usage.invitesByUser.u6, undefined, 'nothing counted');
  for (const exempt of ['granted', ADMIN]) {
    for (let i = 0; i < 4; i++) {
      const room = open(exempt);
      for (let j = 0; j < 3 && (i * 3 + j) < 10; j++) d.reserveInvite(room, 'A', { id: exempt, login: 'octocat' });
    }
    assert.equal(h.app.store.state.usage.invitesByUser[exempt], 10, `${exempt} is held to the per-user cap`);
    assert.throws(() => d.reserveInvite(open(exempt), 'A', { id: exempt, login: 'octocat' }), refused);
  }
  assert.equal(h.app.store.state.usage.invitesTotal, 50, 'exempt invites do not count toward the global cap');
});

test('the same address is allowed 3 a day across users and rooms: the fourth is 429 invite_address_limit, counts nothing, and the case does not matter', T, async (t) => {
  const h = await boot(t);
  const a = await h.signIn(1001);
  const b = await h.signIn(1002);
  const roomA = await openRoom(h, a);
  const roomB = await openRoom(h, b);
  assert.equal((await invite(h, a, roomA, 'Same@Example.com')).status, 202);
  assert.equal((await invite(h, b, roomB, 'same@example.com')).status, 202);
  const roomA2 = await openRoom(h, a);
  assert.equal((await invite(h, a, roomA2, 'SAME@example.COM')).status, 202);
  const roomA3 = await openRoom(h, a);
  const before = JSON.stringify(h.app.store.state.usage);
  const r = await invite(h, a, roomA3, 'same@example.com');
  assert.equal(r.status, 429);
  assert.equal(codeOf(r), 'invite_address_limit');
  assert.equal(JSON.stringify(h.app.store.state.usage), before, 'the refused invite counted nothing');
  assert.equal(h.app.domain.rooms.get(roomA3.id).invitesSent, undefined);
  assert.equal((await invite(h, a, roomA3, 'different@example.com')).status, 202);
  // parallel posts to one address cannot get past 3 either
  const addressRooms = [];
  for (let i = 0; i < 8; i++) addressRooms.push(await openRoom(h, b));
  const results = await Promise.all(addressRooms.map((room) => invite(h, b, room, 'race@example.com')));
  assert.equal(results.filter((x) => x.status === 202).length, 3);
  assert.deepEqual([...new Set(results.filter((x) => x.status !== 202).map((x) => `${x.status} ${codeOf(x)}`))], ['429 invite_address_limit']);
});

test('the same mailbox in its usual spellings shares one allowance: case, a +tag, Gmail dots and googlemail', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const variants = ['jane.doe@gmail.com', 'Jane.Doe+news@Gmail.com', 'janedoe@googlemail.com'];
  for (const v of variants) assert.equal((await invite(h, cookie, await openRoom(h, cookie), v)).status, 202, v);
  const fourth = await invite(h, cookie, await openRoom(h, cookie), 'j.a.n.e.d.o.e+x@gmail.com');
  assert.equal(codeOf(fourth), 'invite_address_limit');
  // other providers keep their dots (they can be different mailboxes), but not the +tag or the case
  const { notices: n } = mkNotices();
  assert.equal(n.inviteAllowed('a.b@example.com'), true);
  for (let i = 0; i < 3; i++) n.sendInvite({ to: 'a.b+' + i + '@Example.com', login: 'octocat', link: PUBLIC + '/room/x' });
  assert.equal(n.inviteAllowed('A.B@example.com'), false);
  assert.equal(n.inviteAllowed('ab@example.com'), true);
});

test('the address cap is checked last: a demo room, a non-owner and a taken room never learn whether an address is capped', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const other = await h.signIn(1002);
  const capped = 'capped@example.com';
  for (let i = 0; i < 3; i++) assert.equal((await invite(h, cookie, await openRoom(h, cookie), capped)).status, 202);
  assert.equal(codeOf(await invite(h, cookie, await openRoom(h, cookie), capped)), 'invite_address_limit', 'the address is capped');
  const demo = (await h.post('/api/demo', { origin: null })).json;
  assert.equal((await invite(h, cookie, { id: demo.id, A: demo.token }, capped)).status, 404, 'demo');
  const mine = await openRoom(h, cookie);
  assert.equal((await invite(h, other, mine, capped)).status, 403, 'not the owner');
  const taken = await openRoom(h, cookie);
  h.app.domain.joinAsAgent(h.app.domain.rooms.get(taken.id), 'B', 'Their agent');
  assert.equal((await invite(h, cookie, taken, capped)).status, 409, 'taken');
  // the room's own cap and the person's come before the address too
  const full = await openRoom(h, cookie);
  for (let i = 0; i < 3; i++) assert.equal((await invite(h, cookie, full, 'free' + i + '@example.com')).status, 202);
  assert.equal(codeOf(await invite(h, cookie, full, capped)), 'invite_limit', 'the room cap, not the address');
  assert.equal(h.mailer.sent.length, 6);
});

test('reserveInvite: recipientOk is asked last, after every refusal that does not depend on the address, and a refusal counts nothing', T, async (t) => {
  const h = await boot(t, { listen: false });
  const d = h.app.domain;
  const calls = [];
  const room = d.createLiveRoom('203.0.113.1', { topic: 'T', modeA: 'external', modeB: 'external' }, { id: '1001', login: 'octocat' });
  const user = { id: '1001', login: 'octocat' };
  const usageBefore = JSON.stringify(h.app.store.state.usage);
  // a refusal before the address check never calls it
  assert.throws(() => d.reserveInvite(room, 'B', user, { recipientOk: () => { calls.push(1); return true; } }), (e) => e.code === 404);
  assert.throws(() => d.reserveInvite(room, 'A', { id: '9', login: 'x' }, { recipientOk: () => { calls.push(1); return true; } }), (e) => e.code === 403);
  assert.deepEqual(calls, []);
  assert.throws(() => d.reserveInvite(room, 'A', user, { recipientOk: () => false }), (e) => e.code === 429 && e.apiCode === 'invite_address_limit');
  assert.equal(JSON.stringify(h.app.store.state.usage), usageBefore, 'a refused address counts nothing');
  assert.equal(room.invitesSent, undefined);
  assert.equal(typeof d.reserveInvite(room, 'A', user, { recipientOk: () => true }), 'string');
});

test('over HTTP, saving that has been failing is 503 saving_unavailable and nothing is counted or sent', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  const real = h.app.store.health;
  h.app.store.health = () => ({ ok: false, failingSince: 1 });
  const r = await invite(h, cookie, room, SOMEONE);
  h.app.store.health = real;
  assert.equal(r.status, 503);
  assert.equal(codeOf(r), 'saving_unavailable');
  assert.equal(h.mailer.sent.length, 0);
  assert.equal(h.app.domain.rooms.get(room.id).invitesSent, undefined);
  assert.equal(h.app.store.state.usage.invitesTotal, 0);
});

test('the body is small (4096): a larger one is 413 before anything is read into the domain', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  const r = await invite(h, cookie, room, SOMEONE, { body: { pad: 'x'.repeat(5000) } });
  assert.equal(r.status, 413);
  assert.equal(h.mailer.sent.length, 0);
  assert.equal((await invite(h, cookie, room, SOMEONE, { body: { pad: 'x'.repeat(2000) } })).status, 202);
});

test('mail_off: undeliverable mail is 503 mail_off, nothing is counted or sent, and the address slot is not used', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  h.mailer.up = false;
  for (let i = 0; i < 5; i++) {
    const r = await invite(h, cookie, room, SOMEONE);
    assert.equal(r.status, 503);
    assert.equal(codeOf(r), 'mail_off');
  }
  assert.equal(h.mailer.sent.length, 0);
  assert.equal(h.app.domain.rooms.get(room.id).invitesSent, undefined);
  assert.equal(h.app.store.state.usage.invitesTotal, 0);
  assert.deepEqual(Object.keys(h.app.store.state.usage.invitesByUser), []);
  h.mailer.up = true;
  for (let i = 0; i < 3; i++) assert.equal((await invite(h, cookie, room, SOMEONE)).status, 202, 'the address and the room are untouched');
});

test('the order of refusals: the token and the shape come before mail_off, and the domain checks come after it', T, async (t) => {
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const other = await h.signIn(1002);
  const room = await openRoom(h, cookie);
  h.mailer.up = false;
  assert.equal((await invite(h, cookie, room, 'nope')).status, 400, 'the shape first');
  assert.equal((await invite(h, cookie, room, SOMEONE, { body: { token: 'wrong' } })).status, 403, 'the seat token first');
  assert.equal(codeOf(await invite(h, other, room, SOMEONE)), 'mail_off', 'the owner is checked by the domain, after the mail check');
  h.mailer.up = true;
  assert.equal((await invite(h, other, room, SOMEONE)).status, 403);
});

test('the address is never in the room, the usage, the log, the disk or the outbox', T, async (t) => {
  const secret = 'never-store-me@example.com';
  const h = await boot(t);
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  assert.equal((await invite(h, cookie, room, secret)).status, 202);
  assert.equal((await invite(h, cookie, room, 'x')).status, 400);
  const bad = await invite(h, cookie, room, secret.toUpperCase().replace('EXAMPLE', 'example'), { body: { token: 'wrong' } });
  assert.equal(bad.status, 403);
  assert.ok(!bad.text.includes('never-store-me'), 'not echoed in an error');
  const live = h.app.domain.rooms.get(room.id);
  assert.ok(!JSON.stringify(live).toLowerCase().includes('never-store-me'));
  assert.ok(!JSON.stringify(h.app.store.state.usage).includes('never-store-me'));
  assert.ok(!h.out.join('').toLowerCase().includes('never-store-me'));
  await h.stopForRestart();
  const walk = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((n) => walk(path.join(p, n))) : [p]);
  for (const f of walk(h.dir)) assert.ok(!fs.readFileSync(f, 'utf8').toLowerCase().includes('never-store-me'), f);
});

test('on the platform the real dev transport is not used for an invite: 503 mail_off, and the outbox folder gets nothing', T, async (t) => {
  const secret = 'outbox-probe@example.com';
  const dir = mkTmp('invite-outbox-');
  t.after(() => rmTmp(dir));
  const { createMailer } = require('../lib/mail');
  const { log } = capture();
  const env = { DROP_DATA_DIR: path.join(dir, 'data'), SIGNIN: 'github', PUBLIC_URL: PUBLIC };
  const real = createMailer({ config: loadConfig(env), secrets: loadSecrets({}), log });
  const h = await boot(t, { dir, mailer: real, env: { MAIL_TRANSPORT: 'dev', DROP_DATA_DIR: path.join(dir, 'data') } });
  assert.equal(h.config.devOutbox, false);
  const cookie = await h.signIn(1001);
  const room = await openRoom(h, cookie);
  const r = await invite(h, cookie, room, secret);
  assert.equal(r.status, 503);
  assert.equal(codeOf(r), 'mail_off');
  await h.stopForRestart();
  const outbox = path.join(dir, 'data', 'outbox');
  const files = fs.existsSync(outbox) ? fs.readdirSync(outbox) : [];
  assert.deepEqual(files, [], 'nothing written to the outbox');
  assert.ok(!h.out.join('').includes('outbox-probe'));
});

test('the counts survive a restart, and a restart does not give the day back', T, async (t) => {
  const dir = mkTmp('invite-restart-');
  t.after(() => rmTmp(dir));
  const first = await boot(t, { dir, listen: false });
  const d1 = first.app.domain;
  const ann = { id: '1001', login: 'octocat' };
  const room = d1.createLiveRoom('203.0.113.1', { topic: 'T', modeA: 'external', modeB: 'external' }, ann);
  d1.reserveInvite(room, 'A', ann);
  d1.reserveInvite(room, 'A', ann);
  const other = d1.createLiveRoom('203.0.113.1', { topic: 'T', modeA: 'external', modeB: 'external' }, ann);
  d1.reserveInvite(other, 'A', ann);
  await first.stopForRestart();
  assert.match(fs.readFileSync(path.join(dir, 'data', 'rooms.json'), 'utf8'), /"invitesTotal":3/);
  const second = await boot(t, { dir, listen: false });
  const d2 = second.app.domain;
  assert.equal(d2.rooms.get(room.id).invitesSent, 2, 'the room count');
  assert.equal(second.app.store.state.usage.invitesTotal, 3);
  assert.deepEqual(Object.assign({}, second.app.store.state.usage.invitesByUser), { 1001: 3 });
  d2.reserveInvite(d2.rooms.get(room.id), 'A', ann);
  assert.throws(() => d2.reserveInvite(d2.rooms.get(room.id), 'A', ann), (e) => e.apiCode === 'invite_limit', 'the room cap survived');
  await second.stopForRestart();
});

test('a damaged room count counts as spent, and a new day empties the user and total counts', T, async (t) => {
  const h = await boot(t, { listen: false });
  const d = h.app.domain;
  const ann = { id: '1001', login: 'octocat' };
  const room = d.createLiveRoom('203.0.113.1', { topic: 'T', modeA: 'external', modeB: 'external' }, ann);
  for (const bad of [-1, 'x', null, NaN, {}, 3, 99]) {
    room.invitesSent = bad;
    assert.throws(() => d.reserveInvite(room, 'A', ann), (e) => e.apiCode === 'invite_limit', String(bad));
  }
  assert.equal(h.app.store.state.usage.invitesTotal, 0);
  delete room.invitesSent;
  d.reserveInvite(room, 'A', ann);
  assert.equal(h.app.store.state.usage.invitesTotal, 1);
  h.clock.t += 2 * DAY;
  d.reserveInvite(room, 'A', ann);
  assert.equal(h.app.store.state.usage.invitesTotal, 1, 'reset by the new day, then one');
  assert.deepEqual(Object.assign({}, h.app.store.state.usage.invitesByUser), { 1001: 1 });
});

test('reserveInvite with sign-in off is 404 and counts nothing', T, async (t) => {
  const h = await boot(t, { signin: 'off', listen: false });
  const d = h.app.domain;
  const room = d.createLiveRoom('203.0.113.1', { topic: 'T', modeA: 'external', modeB: 'external' });
  assert.throws(() => d.reserveInvite(room, 'A', { id: '1', login: 'x' }), (e) => e.code === 404);
  assert.equal(h.app.store.state.usage.invitesTotal, 0);
});
