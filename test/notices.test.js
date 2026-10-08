'use strict';
// lib/notices.js (the admin note about a new "Use our AI" request), its wiring in lib/app.js, and ADMIN_EMAIL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createNotices, HOURLY_MAX, DAILY_MAX, SUBJECT } = require('../lib/notices');
const { createApp } = require('../lib/app');
const { createAiAccess, MAX_PENDING } = require('../lib/ai-access');
const { createStore } = require('../lib/store');
const { loadConfig, loadSecrets } = require('../lib/config');
const { createLog } = require('../lib/log');
const { TAGS } = require('../lib/mail');
const { mkTmp, rmTmp } = require('../test-support/server');
const { fakeProxy } = require('../test-support/app');

const MARKER = 'LEAK-MARKER';
const ADMIN_EMAIL = 'owner@example.com';
const PUBLIC = 'https://behalf.test';
const HOUR = 60 * 60 * 1000;

const capture = () => { const out = []; return { out, log: createLog({ stream: { write: (s) => out.push(s) } }) }; };
const mkClock = (t = 1700000000000) => { const c = { t, now: () => c.t }; return c; };
function fakeMailer(send) {
  const sent = [];
  return { sent, sendMail: (m) => { sent.push(m); return send ? send(m) : Promise.resolve({ status: 'sent', attempts: 1 }); } };
}
function mk({ adminEmail = ADMIN_EMAIL, deliverable = () => true, send, clock = mkClock() } = {}) {
  const mailer = fakeMailer(send);
  const { out, log } = capture();
  const notices = createNotices({ mailer, deliverable, adminEmail, publicUrl: PUBLIC, clock, log });
  return { notices, mailer, out, clock };
}
const tick = () => new Promise((r) => setImmediate(r));

test('the email: fixed subject and tag, names the requester as a GitHub user, links the admin page, has no note', () => {
  const { notices, mailer } = mk();
  notices.adminRequest({ id: '1', login: 'octo-cat' });
  assert.equal(mailer.sent.length, 1);
  const m = mailer.sent[0];
  assert.equal(m.to, ADMIN_EMAIL);
  assert.equal(m.subject, 'Someone asked to use our AI on Behalf');
  assert.equal(m.subject, SUBJECT);
  assert.equal(m.tag, 'access_request');
  assert.ok(TAGS.includes(m.tag));
  assert.match(m.text, /A GitHub user, @octo-cat, asked to use our AI on Behalf\./);
  assert.ok(m.text.includes('https://github.com/octo-cat'));
  assert.ok(m.text.includes('Open the admin page to read their note.'));
  assert.ok(m.text.includes(`${PUBLIC}/admin`));
  assert.ok(m.html.includes('<a href="https://github.com/octo-cat">@octo-cat</a>'));
  assert.ok(m.html.includes(`<a href="${PUBLIC}/admin">`));
  assert.ok(!/more request/.test(m.text), 'no waiting line when nothing was held back');
});

test('the note never reaches the email, whatever is on the user', () => {
  const { notices, mailer } = mk();
  notices.adminRequest({ id: '1', login: 'octocat', note: `${MARKER} https://evil.example` });
  const m = mailer.sent[0];
  assert.ok(!m.text.includes(MARKER) && !m.html.includes(MARKER) && !m.text.includes('evil'));
});

test('a login that fails the GitHub pattern is left out, not escaped into the email', () => {
  for (const login of ['a b', '<script>', 'x'.repeat(40), '', 'a/b', 'octo\ncat', undefined, null, 5, '-"onmouseover=']) {
    const { notices, mailer } = mk();
    notices.adminRequest({ id: '1', login });
    const m = mailer.sent[0];
    assert.match(m.text, /^Someone asked to use our AI on Behalf\./, String(login));
    assert.ok(!m.text.includes('github.com') && !m.html.includes('github.com') && !m.html.includes('<script>'), String(login));
  }
  const { notices, mailer } = mk();
  notices.adminRequest(null);
  assert.match(mailer.sent[0].text, /^Someone asked/);
});

test('off without ADMIN_EMAIL, and off when mail is not deliverable (asked on each call)', () => {
  for (const adminEmail of [null, '']) {
    const { notices, mailer } = mk({ adminEmail });
    notices.adminRequest({ login: 'octocat' });
    assert.equal(mailer.sent.length, 0);
  }
  let ok = false;
  const { notices, mailer } = mk({ deliverable: () => ok });
  notices.adminRequest({ login: 'octocat' });
  assert.equal(mailer.sent.length, 0);
  ok = true;
  notices.adminRequest({ login: 'octocat' });
  assert.equal(mailer.sent.length, 1);
});

const wording = (m) => m.text.split(/\n/).filter((l) => /waiting/.test(l));

test('the waiting line comes from the pending count given: the only one, or N, requester included; none given, none shown', () => {
  const { notices, mailer } = mk();
  notices.adminRequest({ login: 'octocat' }, { pending: 1 });
  notices.adminRequest({ login: 'octocat' }, { pending: 7 });
  notices.adminRequest({ login: 'octocat' }, { pending: 0 });
  notices.adminRequest({ login: 'octocat' }, { pending: 'x' });
  notices.adminRequest({ login: 'octocat' });
  assert.deepEqual(wording(mailer.sent[0]), ['This is the only request waiting.']);
  assert.deepEqual(wording(mailer.sent[1]), ['7 requests are waiting.']);
  assert.ok(mailer.sent[1].html.includes('<p>7 requests are waiting.</p>'));
  for (const i of [2, 3, 4]) assert.deepEqual(wording(mailer.sent[i]), []);
});

test('the hourly cap: 20 go out, the rest are not sent, logged once, and the next sent one shows the pending count then', () => {
  const { notices, mailer, out, clock } = mk();
  for (let i = 0; i < HOURLY_MAX + 3; i++) notices.adminRequest({ login: 'octocat' }, { pending: i + 1 });
  assert.equal(mailer.sent.length, HOURLY_MAX);
  assert.equal(out.filter((l) => l.includes('mail.notify_capped')).length, 1, 'logged once, not per held-back notice');
  clock.t += HOUR;
  notices.adminRequest({ login: 'octocat' }, { pending: 23 });
  assert.equal(mailer.sent.length, HOURLY_MAX + 1);
  assert.deepEqual(wording(mailer.sent[HOURLY_MAX]), ['23 requests are waiting.']);
});

test('mail.notify_capped is logged again once a send has re-armed it', () => {
  const { notices, out, clock } = mk();
  const capped = () => out.filter((l) => l.includes('mail.notify_capped')).length;
  for (let i = 0; i < HOURLY_MAX + 2; i++) notices.adminRequest({ login: 'octocat' });
  assert.equal(capped(), 1);
  clock.t += HOUR;
  notices.adminRequest({ login: 'octocat' }); // sent: re-arms
  for (let i = 0; i < HOURLY_MAX + 2; i++) notices.adminRequest({ login: 'octocat' });
  assert.equal(capped(), 2);
});

test('the daily cap: 50 in 24 hours however they are spread, and it frees up after a day', () => {
  const { notices, mailer, out, clock } = mk();
  const start = clock.t;
  for (let i = 0; i < DAILY_MAX; i++) {
    clock.t = start + Math.floor(i / HOURLY_MAX) * 2 * HOUR + i; // 20 an hour at most, 3 batches
    notices.adminRequest({ login: 'octocat' });
  }
  assert.equal(mailer.sent.length, DAILY_MAX);
  clock.t = start + 10 * HOUR;
  notices.adminRequest({ login: 'octocat' });
  notices.adminRequest({ login: 'octocat' });
  assert.equal(mailer.sent.length, DAILY_MAX, 'held back by the daily cap');
  assert.equal(out.filter((l) => l.includes('mail.notify_capped')).length, 1);
  clock.t = start + 24 * HOUR + 10 * HOUR; // the first batches have aged out
  notices.adminRequest({ login: 'octocat' });
  assert.equal(mailer.sent.length, DAILY_MAX + 1);
});

test('adminEmail set but mail not deliverable: mail.notice_skipped is logged once, and again only after a send', () => {
  let ok = false;
  const { notices, mailer, out } = mk({ deliverable: () => ok });
  const skipped = () => out.filter((l) => l.includes('mail.notice_skipped')).length;
  notices.adminRequest({ login: 'octocat' });
  notices.adminRequest({ login: 'octocat' });
  assert.equal(skipped(), 1);
  assert.equal(mailer.sent.length, 0);
  ok = true;
  notices.adminRequest({ login: 'octocat' });
  assert.equal(mailer.sent.length, 1);
  ok = false;
  notices.adminRequest({ login: 'octocat' });
  notices.adminRequest({ login: 'octocat' });
  assert.equal(skipped(), 2);
  const none = mk({ adminEmail: null, deliverable: () => false });
  none.notices.adminRequest({ login: 'octocat' });
  assert.ok(!none.out.join('').includes('mail.notice_skipped'), 'no address, nothing to skip');
});

test('notices.deliverable is the predicate it was given', () => {
  const deliverable = () => true;
  const { notices } = mk({ deliverable });
  assert.equal(notices.deliverable, deliverable);
});

test('a send that throws, and one that rejects, are logged without an address or subject and never escape', async () => {
  for (const send of [() => { throw new Error(`${MARKER} ${ADMIN_EMAIL}`); }, () => Promise.reject(new Error(`${MARKER} ${ADMIN_EMAIL}`))]) {
    const { notices, out } = mk({ send });
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e; };
    process.once('unhandledRejection', onUnhandled);
    assert.doesNotThrow(() => notices.adminRequest({ login: 'octocat' }));
    await tick(); await tick();
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, null);
    const logged = out.join('');
    assert.ok(logged.includes('mail.notice_failed'));
    for (const secret of [MARKER, ADMIN_EMAIL, SUBJECT, 'octocat']) assert.ok(!logged.includes(secret), secret);
  }
});

test('a deliverable() that throws does not escape either', () => {
  const { notices, out } = mk({ deliverable: () => { throw new Error('x'); } });
  assert.doesNotThrow(() => notices.adminRequest({ login: 'octocat' }));
  assert.ok(out.join('').includes('mail.notice_failed'));
});

test('ADMIN_EMAIL: one address, strict, unset is null, and the message never holds the value', () => {
  assert.equal(loadConfig({}).adminEmail, null);
  assert.equal(loadConfig({ ADMIN_EMAIL: '  ' }).adminEmail, null);
  assert.equal(loadConfig({ ADMIN_EMAIL: ` ${ADMIN_EMAIL} ` }).adminEmail, ADMIN_EMAIL);
  for (const bad of ['nobody', 'a@b', 'a@b.co, c@d.co', 'Owner <a@b.co>', 'a@b.co\r\nBcc: e@vil.co', `${MARKER}`, 'a b@c.co']) {
    assert.throws(() => loadConfig({ ADMIN_EMAIL: bad }), (e) => e.code === 'BAD_ADMIN_EMAIL' && !e.message.includes(MARKER), bad);
  }
});

// ---------- through the app ----------
function boot(t, { env = {}, mailer = fakeMailer() } = {}) {
  const dir = mkTmp('notices-app-');
  const { out, log } = capture();
  const config = loadConfig({
    SIGNIN: 'github', DROP_DATA_DIR: path.join(dir, 'data'), PUBLIC_URL: PUBLIC, ADMIN_GITHUB_IDS: '1003', ADMIN_EMAIL, MAIL_TRANSPORT: 'smtp',
    SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', MAIL_FROM: 'Behalf <invites@example.com>', ...env,
  });
  const store = createStore({ file: path.join(dir, 'data', 'rooms.json'), log });
  store.load();
  const app = createApp({
    config, secrets: loadSecrets({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', SMTP_USER: 'u', SMTP_PASS: 'p' }), log, store, proxy: fakeProxy(),
    mailer: { kind: 'smtp', start() {}, close() {}, status: () => 'ready', available: () => true, outbox: null, ...mailer },
  });
  t.after(async () => { await app.drain().catch(() => {}); app.close(); rmTmp(dir); });
  app.store.collection('user').map.set('1001', { id: '1001', login: 'octocat', createdAt: 1, lastLoginAt: 1 });
  return { app, out, mailer };
}

test('app: the email goes out on the move to requested only, never on a note update', (t) => {
  const { app, mailer } = boot(t);
  const user = { id: '1001', login: 'octocat' };
  assert.deepEqual(app.aiAccess.request(user, 'first note'), { ok: true, status: 'requested' });
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, ADMIN_EMAIL);
  assert.ok(!mailer.sent[0].text.includes('first note'));
  app.aiAccess.request(user, 'a second note');
  app.aiAccess.request(user, '');
  assert.equal(mailer.sent.length, 1, 'a note update sends nothing');
});

test('app: the email shows the real pending count, and a refused request sends nothing', (t) => {
  const { app, mailer } = boot(t);
  app.store.collection('user').map.set('1002', { id: '1002', login: 'second', createdAt: 1, lastLoginAt: 1 });
  app.aiAccess.request({ id: '1001', login: 'octocat' }, 'n');
  app.aiAccess.request({ id: '1002', login: 'second' }, 'n');
  assert.ok(mailer.sent[0].text.includes('This is the only request waiting.'));
  assert.ok(mailer.sent[1].text.includes('2 requests are waiting.'));
  // refused: a bad note, then the rate limit
  const before = mailer.sent.length;
  assert.deepEqual(app.aiAccess.request({ id: '1003', login: 'third' }, 'a\ud800b'),{ ok: false, reason: 'note' });
  for (let i = 0; i < 8; i++) app.aiAccess.request({ id: '1004', login: 'fourth' }, 'n');
  assert.equal(mailer.sent.length, before + 1, 'only the first of the rate-limited user went out');
});

test('a request refused as full sends nothing, and the pending count given is the set after the move', () => {
  const { notices, mailer } = mk();
  const map = new Map();
  for (let i = 0; i < MAX_PENDING; i++) map.set(`u${i}`, { status: 'requested', note: '', requestedAt: 1, decidedAt: null, decidedBy: null });
  const store = { collection: () => ({ map, save() {} }), persist: async () => true, health: () => ({ failingSince: null }) };
  const config = loadConfig({ SIGNIN: 'github', PUBLIC_URL: PUBLIC });
  const ai = createAiAccess({ store, config, canRevoke: () => true, userInfo: (id) => ({ id, login: 'x' }), log: capture().log, notify: notices.adminRequest });
  assert.deepEqual(ai.request({ id: 'new', login: 'octocat' }, 'n'), { ok: false, reason: 'full' });
  assert.equal(mailer.sent.length, 0);
  map.delete('u0');
  const fresh = createAiAccess({ store, config, canRevoke: () => true, userInfo: (id) => ({ id, login: 'x' }), log: capture().log, notify: notices.adminRequest });
  assert.deepEqual(fresh.request({ id: 'new', login: 'octocat' }, 'n'), { ok: true, status: 'requested' });
  assert.ok(mailer.sent[0].text.includes(`${MAX_PENDING} requests are waiting.`));
});

test('app: an admin reset, then a new request, sends a second email', async (t) => {
  const { app, mailer } = boot(t);
  const user = { id: '1001', login: 'octocat' };
  app.aiAccess.request(user, 'n');
  assert.equal(mailer.sent.length, 1);
  assert.deepEqual(await app.aiAccess.decide('1001', 'reset', '1003'), { ok: true });
  assert.equal(app.aiAccess.status(user), 'none');
  app.aiAccess.request(user, 'again');
  assert.equal(mailer.sent.length, 2);
});

test('app: no email while saving is failing (canRevoke false)', (t) => {
  const { app, mailer } = boot(t);
  const real = app.store.health;
  app.store.health = () => ({ ...real(), failingSince: 1 });
  app.aiAccess.request({ id: '1001', login: 'octocat' }, 'n');
  assert.equal(mailer.sent.length, 0);
});

test('app: a mailer that throws or rejects does not fail the request or crash', async (t) => {
  for (const send of [() => { throw new Error('boom'); }, () => Promise.reject(new Error('boom'))]) {
    const { app, out } = boot(t, { mailer: fakeMailer(send) });
    assert.deepEqual(app.aiAccess.request({ id: '1001', login: 'octocat' }, 'n'), { ok: true, status: 'requested' });
    await tick(); await tick();
    assert.ok(out.join('').includes('mail.notice_failed'));
    assert.equal(app.aiAccess.status({ id: '1001' }), 'requested');
  }
});

test('app: the dev transport on the platform is not deliverable: nothing is sent and boot warns', (t) => {
  const { app, out, mailer } = boot(t, { env: { MAIL_TRANSPORT: 'dev' } }); // DROP_DATA_DIR set: devOutbox is false
  assert.equal(app.config.devOutbox, false);
  assert.ok(out.join('').includes('mail.admin_email_unused'));
  app.aiAccess.request({ id: '1001', login: 'octocat' }, 'n');
  assert.equal(mailer.sent.length, 0);
});

test('app: the dev transport off the platform is deliverable, and a working smtp mailer boots without the warning', (t) => {
  const smtp = boot(t);
  assert.ok(!smtp.out.join('').includes('mail.admin_email_unused'));
  const dev = boot(t, { env: { MAIL_TRANSPORT: 'dev', DROP_DATA_DIR: '', SIGNIN: 'github' } });
  assert.equal(dev.app.config.devOutbox, true);
  dev.app.aiAccess.request({ id: '1001', login: 'octocat' }, 'n');
  assert.equal(dev.mailer.sent.length, 1);
});

test('app: a mailer that turned itself off (or is not verified yet) stops the notices, with no boot warning but one skipped line', (t) => {
  const { app, mailer, out } = boot(t, { mailer: { available: () => false, ...fakeMailer() } });
  assert.ok(!out.join('').includes('mail.admin_email_unused'), 'smtp is configured: the static half says it can work');
  app.aiAccess.request({ id: '1001', login: 'octocat' }, 'n');
  assert.equal(mailer.sent.length, 0);
  assert.equal(out.filter((l) => l.includes('mail.notice_skipped')).length, 1);
});

test('app: ADMIN_EMAIL with sign-in off can never be used, and boot says so', (t) => {
  const { out } = boot(t, { env: { SIGNIN: 'off' } });
  assert.ok(out.join('').includes('mail.admin_email_unused'));
});

test('app: no ADMIN_EMAIL, no email and no warning', (t) => {
  const { app, out, mailer } = boot(t, { env: { ADMIN_EMAIL: '' } });
  app.aiAccess.request({ id: '1001', login: 'octocat' }, 'n');
  assert.equal(mailer.sent.length, 0);
  assert.ok(!out.join('').includes('mail.admin_email_unused'));
});

test('the address is not in /api/config or /health', async (t) => {
  const { app } = boot(t);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const p of ['/api/config', '/health']) {
    const r = await fetch(base + p);
    assert.ok(!(await r.text()).includes(ADMIN_EMAIL), p);
  }
});

// ---------- shared pieces moved by this change ----------
test('isEmail: one function for MAIL_FROM, ADMIN_EMAIL and the mailer, with the 254 bound', () => {
  const { isEmail } = require('../lib/config');
  assert.equal(require('../lib/mail').isEmail, isEmail, 'mail.js re-exports config.isEmail');
  assert.equal(isEmail('a@b.co'), true);
  assert.equal(isEmail(5), false);
  assert.equal(isEmail(null), false);
  const ok = 'x'.repeat(10) + '@' + ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'd'.repeat(55)].join('.'); // 10+1+60*3+55+3 = 249
  assert.ok(ok.length <= 254 && isEmail(ok), 'under the bound');
  const edge = 'x'.repeat(64) + '@' + ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'd'.repeat(2)].join('.');
  const long = 'x'.repeat(64) + '@' + ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'd'.repeat(10)].join('.');
  assert.ok(edge.length <= 254 && long.length > 254, `${edge.length} ${long.length}`);
  assert.equal(isEmail(edge), true);
  assert.equal(isEmail(long), false, 'over 254 characters');
});

test('MAIL_FROM and ADMIN_EMAIL refuse an address over 254 characters alike', () => {
  const long = 'x'.repeat(64) + '@' + ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'd'.repeat(10)].join('.');
  assert.throws(() => loadConfig({ MAIL_FROM: long }), (e) => e.code === 'BAD_MAIL_FROM');
  assert.throws(() => loadConfig({ ADMIN_EMAIL: long }), (e) => e.code === 'BAD_ADMIN_EMAIL');
  assert.deepEqual({ ...loadConfig({ MAIL_FROM: 'Behalf <a@b.co>' }).mailFrom }, { name: 'Behalf', address: 'a@b.co' });
});

test('LOGIN (lib/text.js) is the GitHub user name pattern: 1 to 39 of letters, digits, hyphen', () => {
  const { LOGIN } = require('../lib/text');
  for (const ok of ['a', 'octo-cat', 'A1', 'a'.repeat(39)]) assert.ok(LOGIN.test(ok), ok);
  for (const bad of ['', 'a'.repeat(40), 'octo cat', '<b>', 'a_b', 'a\n', 'a.b']) assert.ok(!LOGIN.test(bad), JSON.stringify(bad));
});

test('ai-access on its own: notify gets (user, { pending }) on none to requested only, and not while canRevoke() is false', () => {
  const calls = [];
  const map = new Map();
  let healthy = true;
  const store = { collection: () => ({ map, save() {} }), persist: async () => true, health: () => ({ failingSince: healthy ? null : 1 }) };
  const config = loadConfig({ SIGNIN: 'github', PUBLIC_URL: PUBLIC });
  const ai = createAiAccess({ store, config, canRevoke: () => healthy, userInfo: (id) => ({ id, login: 'u' + id }), log: capture().log, notify: (u, o) => calls.push([u.id, o]) });
  ai.request({ id: '1', login: 'u1' }, 'a');
  ai.request({ id: '1', login: 'u1' }, 'b'); // a repeat
  ai.request({ id: '2', login: 'u2' }, 'a');
  assert.deepEqual(calls, [['1', { pending: 1 }], ['2', { pending: 2 }]]);
  healthy = false;
  ai.request({ id: '3', login: 'u3' }, 'a');
  assert.equal(calls.length, 2);
});
