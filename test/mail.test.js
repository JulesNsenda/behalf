'use strict';
// The mail module: config, message checks, retries, the dev outbox, the SMTP options, and the outbox page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const util = require('util');
const { loadConfig, loadSecrets, consumeSecrets, checkMail, ConfigError } = require('../lib/config');
const { createMailer, classify, normalise, TAGS, MAX_RETRIES } = require('../lib/mail');
const { createDevTransport } = require('../lib/mail-dev');
const { createSmtpTransport, smtpOptions } = require('../lib/mail-smtp');
const { createLog } = require('../lib/log');

const MARKER = 'LEAK-MARKER';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'behalf-mail-'));
const capture = () => { const lines = []; return { lines, log: createLog({ stream: { write: (l) => lines.push(l) } }) }; };
const noSleep = { sleep: async () => {} };
const GOOD = { to: 'client@example.com', toName: 'Thandi', replyTo: 'jules@example.com', subject: 'Jules needs you to confirm 3 things', text: 'Hello', html: '<p>Hello</p>', tag: 'invite' };
const SMTP_ENV = { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', MAIL_FROM: 'Behalf <invites@example.com>' };
const SMTP_SECRETS = { SMTP_USER: 'user', SMTP_PASS: 'pass' };

// A transport whose send answers from a script: each entry is a reply ({ messageId, rejected }) or an error to throw.
function scripted(steps, { verify = async () => {} } = {}) {
  const sent = [];
  return {
    sent,
    transport: {
      kind: 'smtp', verify, close() { this.closed = true; },
      async send(m) { sent.push(m); const s = steps.shift(); if (s instanceof Error) throw s; return s || { messageId: '<ok@x>', rejected: [] }; },
    },
  };
}
const smtpErr = (props) => Object.assign(new Error(`550 5.1.1 <${MARKER}@example.com>: user unknown`), props);
const mailer = (transport, log = capture().log, clock = noSleep) => createMailer({ config: loadConfig({}), secrets: loadSecrets({}), log, clock, transport });

// ---------- config ----------

test('MAIL_TRANSPORT is dev or smtp, dev by default', () => {
  assert.equal(loadConfig({}).mailTransport, 'dev');
  assert.equal(loadConfig({ MAIL_TRANSPORT: 'smtp' }).mailTransport, 'smtp');
  for (const bad of ['SMTP', 'ses', 'off', MARKER]) {
    assert.throws(() => loadConfig({ MAIL_TRANSPORT: bad }), (e) => e instanceof ConfigError && e.code === 'BAD_MAIL_TRANSPORT' && !e.message.includes(MARKER));
  }
});

test('MAIL_FROM takes a bare address or Name <address>, and nothing that could break a header', () => {
  assert.deepEqual({ ...loadConfig({ MAIL_FROM: 'invites@example.com' }).mailFrom }, { name: '', address: 'invites@example.com' });
  assert.deepEqual({ ...loadConfig({ MAIL_FROM: 'Behalf <invites@mail.example.co.za>' }).mailFrom }, { name: 'Behalf', address: 'invites@mail.example.co.za' });
  assert.equal(loadConfig({ MAIL_FROM: '  ' }).mailFrom, null);
  for (const bad of ['nobody', 'a@b', 'Behalf <a@b.c', 'Be<half <a@b.co>', 'x\r\nBcc: e@vil.co <a@b.co>', '"Q" <a@b.co>', `${MARKER} <bad>`, 'a b@c.co']) {
    assert.throws(() => loadConfig({ MAIL_FROM: bad }), (e) => e.code === 'BAD_MAIL_FROM' && !e.message.includes(MARKER), bad);
  }
});

test('SMTP_HOST is a host name, SMTP_PORT a port, SMTP_SECURE true or false', () => {
  assert.equal(loadConfig({ SMTP_HOST: 'mail.example.com' }).smtpHost, 'mail.example.com');
  for (const bad of ['smtp://mail.example.com', 'mail.example.com:587', 'mail example', '-mail.example.com']) {
    assert.throws(() => loadConfig({ SMTP_HOST: bad }), (e) => e.code === 'BAD_SMTP_HOST', bad);
  }
  assert.equal(loadConfig({ SMTP_PORT: '465' }).smtpPort, 465);
  for (const bad of ['0', '65536', 'abc', '587.0']) assert.throws(() => loadConfig({ SMTP_PORT: bad }), (e) => e.code === 'BAD_SMTP_PORT', bad);
  for (const bad of ['yes', '1', 'TRUE']) assert.throws(() => loadConfig({ SMTP_SECURE: bad }), (e) => e.code === 'BAD_SMTP_SECURE', bad);
});

test('checkMail: smtp needs every setting and refuses a port/TLS mix-up; dev needs nothing', () => {
  const ok = () => checkMail(loadConfig(SMTP_ENV), loadSecrets(SMTP_SECRETS));
  assert.doesNotThrow(ok);
  assert.doesNotThrow(() => checkMail(loadConfig({}), loadSecrets({})));
  const cases = [
    [{ SMTP_HOST: '' }, {}, 'BAD_SMTP_HOST'],
    [{ SMTP_PORT: '' }, {}, 'BAD_SMTP_PORT'],
    [{}, { SMTP_USER: '' }, 'BAD_SMTP_AUTH'],
    [{}, { SMTP_PASS: '' }, 'BAD_SMTP_AUTH'],
    [{ MAIL_FROM: '' }, {}, 'BAD_MAIL_FROM'],
    [{ SMTP_PORT: '465', SMTP_SECURE: 'false' }, {}, 'BAD_SMTP_SECURE'],
    [{ SMTP_PORT: '587', SMTP_SECURE: 'true' }, {}, 'BAD_SMTP_SECURE'],
  ];
  for (const [env, sec, code] of cases) {
    assert.throws(() => checkMail(loadConfig({ ...SMTP_ENV, ...env }), loadSecrets({ ...SMTP_SECRETS, ...sec })), (e) => e instanceof ConfigError && e.code === code, code);
  }
  assert.doesNotThrow(() => checkMail(loadConfig({ ...SMTP_ENV, SMTP_PORT: '465' }), loadSecrets(SMTP_SECRETS)), '465 implies TLS');
  assert.doesNotThrow(() => checkMail(loadConfig({ ...SMTP_ENV, SMTP_PORT: '2525', SMTP_SECURE: 'true' }), loadSecrets(SMTP_SECRETS)));
});

test('the SMTP credentials are redacted secrets, removed from the environment and kept out of the config', () => {
  const env = { ...SMTP_ENV, SMTP_USER: 'user-VALUE', SMTP_PASS: 'pass-VALUE', KEEP: '1' };
  const config = loadConfig(env);
  assert.ok(!JSON.stringify(config).includes('VALUE'));
  const s = consumeSecrets(env);
  assert.deepEqual([s.smtpUser, s.smtpPass], ['user-VALUE', 'pass-VALUE']);
  assert.ok(!('SMTP_USER' in env) && !('SMTP_PASS' in env) && env.KEEP === '1');
  for (const text of [JSON.stringify(s), util.inspect(s, { showHidden: true })]) assert.ok(!text.includes('VALUE'), text);
});

test('the outbox page is on only off the platform', () => {
  assert.equal(loadConfig({}).devOutbox, true);
  assert.equal(loadConfig({ DROP_DATA_DIR: '/data', SIGNIN: 'off' }).devOutbox, false);
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://x', SIGNIN: 'off' }).devOutbox, false);
});

// ---------- messages ----------

test('normalise accepts a proper message and refuses anything that could forge a header or is not one of ours', () => {
  const from = { name: 'Behalf', address: 'invites@example.com' };
  const m = normalise({ ...GOOD, fromName: 'Jules via Behalf' }, from);
  assert.deepEqual(m.from, { name: 'Jules via Behalf', address: 'invites@example.com' });
  assert.deepEqual(m.to, { name: 'Thandi', address: 'client@example.com' });
  assert.equal(m.replyTo, 'jules@example.com');
  assert.equal(normalise({ ...GOOD, fromName: undefined }, from).from.name, 'Behalf');
  assert.equal(normalise({ ...GOOD, toName: 'A\r\nBcc: x@evil.com' }, from).to.name, 'A Bcc: x@evil.com', 'a name cannot start a header');
  assert.equal(normalise({ ...GOOD, toName: 'x'.repeat(500) }, from).to.name.length, 80);
  const bad = [
    { to: 'not-an-email' }, { to: 'a@b.co\r\nBcc: x@evil.com' }, { to: `${'a'.repeat(250)}@b.co` }, { to: ['a@b.co', 'c@d.co'] },
    { replyTo: 'nope' }, { subject: 'Hi\r\nBcc: x@evil.com' }, { subject: '' }, { subject: 'x'.repeat(201) },
    { text: '' }, { text: 42 }, { html: 42 }, { tag: 'marketing' }, { tag: undefined },
  ];
  for (const b of bad) assert.equal(normalise({ ...GOOD, ...b }, from), null, JSON.stringify(b).slice(0, 80));
  assert.equal(normalise(null, from), null);
});

test('classify: an SMTP 4xx is temporary, a 5xx permanent; only connection failures are retried without a reply code', () => {
  assert.deepEqual(classify({ responseCode: 421 }), { code: 'SMTP_421', temporary: true });
  assert.deepEqual(classify({ responseCode: 451, code: 'EENVELOPE' }), { code: 'SMTP_451', temporary: true });
  assert.deepEqual(classify({ responseCode: 550, code: 'EENVELOPE' }), { code: 'SMTP_550', temporary: false });
  assert.deepEqual(classify({ responseCode: 535, code: 'EAUTH' }), { code: 'SMTP_535', temporary: false });
  assert.deepEqual(classify({ code: 'ECONNECTION' }), { code: 'ECONNECTION', temporary: true });
  assert.deepEqual(classify({ code: 'EAUTH' }), { code: 'EAUTH', temporary: false });
  assert.deepEqual(classify({ code: 'ETLS' }), { code: 'ETLS', temporary: false });
  assert.deepEqual(classify({ code: `x ${MARKER}` }), { code: 'EMAIL', temporary: false });
  assert.deepEqual(classify(undefined), { code: 'EMAIL', temporary: false });
});

// ---------- sending ----------

test('a send returns the message id; the tag and the transport are logged, never the address or the subject', async () => {
  const { lines, log } = capture();
  const { transport, sent } = scripted([{ messageId: '<abc@mail>', rejected: [] }]);
  const out = await mailer(transport, log).sendMail(GOOD);
  assert.deepEqual(out, { status: 'sent', messageId: '<abc@mail>', attempts: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tag, undefined, 'the tag is ours, not a header');
  const text = lines.join('');
  assert.match(text, /event="mail.sent" status="smtp" tag="invite"/);
  for (const secret of ['client@example.com', 'jules@example.com', 'Thandi', 'confirm 3 things', 'Hello']) assert.ok(!text.includes(secret), secret);
});

test('a temporary failure is retried up to 3 times with growing waits, then reported as failed and not permanent', async () => {
  const waits = [];
  const { lines, log } = capture();
  const { transport, sent } = scripted([1, 2, 3, 4].map(() => smtpErr({ responseCode: 451, code: 'EENVELOPE' })));
  const out = await mailer(transport, log, { sleep: async (ms) => { waits.push(ms); } }).sendMail(GOOD);
  assert.deepEqual(out, { status: 'failed', code: 'SMTP_451', permanent: false, attempts: MAX_RETRIES + 1 });
  assert.equal(sent.length, 4);
  assert.equal(waits.length, 3);
  assert.ok(waits[0] >= 2000 && waits[0] < waits[1] && waits[1] < waits[2], String(waits));
  assert.equal(lines.filter((l) => l.includes('mail.retry')).length, 3);
  assert.ok(!lines.join('').includes(MARKER), 'the server reply is never logged');
});

test('a temporary failure that then succeeds is sent', async () => {
  const { transport } = scripted([smtpErr({ code: 'ECONNECTION' }), { messageId: '<late@mail>', rejected: [] }]);
  assert.deepEqual(await mailer(transport).sendMail(GOOD), { status: 'sent', messageId: '<late@mail>', attempts: 2 });
});

test('a permanent failure or a rejected recipient is not retried', async () => {
  for (const step of [smtpErr({ responseCode: 550, code: 'EENVELOPE' }), smtpErr({ code: 'EAUTH' }), { messageId: '<x>', rejected: ['client@example.com'] }]) {
    const { lines, log } = capture();
    const { transport, sent } = scripted([step]);
    const out = await mailer(transport, log).sendMail(GOOD);
    assert.equal(out.status, 'failed');
    assert.equal(out.permanent, true);
    assert.equal(out.attempts, 1);
    assert.equal(sent.length, 1);
    assert.match(lines.join(''), /event="mail.failed"/);
    assert.ok(!lines.join('').includes(MARKER) && !lines.join('').includes('client@example.com'));
  }
});

test('a send that times out locally is not retried: the server may have taken it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { transport, sent } = scripted([]);
  transport.send = (m) => { sent.push(m); return new Promise(() => {}); };
  const m = mailer(transport);
  await m.start();
  const pending = m.sendMail(GOOD);
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(60000);
  const out = await pending;
  assert.deepEqual(out, { status: 'failed', code: 'MAIL_TIMEOUT', permanent: false, attempts: 1 });
  assert.equal(sent.length, 1);
});

test('a bad message is refused before the transport sees it', async () => {
  const { transport, sent } = scripted([]);
  assert.deepEqual(await mailer(transport).sendMail({ ...GOOD, to: 'nope' }), { status: 'failed', code: 'MAIL_INVALID', permanent: true, attempts: 0 });
  assert.equal(sent.length, 0);
});

test('a failed check turns sending off, logs once with a code, and leaves the caller a clear answer', async () => {
  const { lines, log } = capture();
  const { transport, sent } = scripted([], { verify: async () => { throw smtpErr({ code: 'EAUTH', responseCode: 535 }); } });
  const m = mailer(transport, log);
  assert.equal(m.status(), 'checking');
  assert.equal(m.available(), true);
  await m.start();
  assert.equal(m.status(), 'unavailable');
  assert.equal(m.available(), false);
  assert.deepEqual(await m.sendMail(GOOD), { status: 'failed', code: 'MAIL_UNAVAILABLE', permanent: false, attempts: 0 });
  assert.equal(sent.length, 0);
  assert.match(lines.join(''), /level=error event="mail.verify_failed" status="smtp" errorClass="MailError" code="SMTP_535"/);
  assert.ok(!lines.join('').includes(MARKER));
});

test('a send before the check finishes waits for it', async () => {
  let pass;
  const { transport, sent } = scripted([], { verify: () => new Promise((r) => { pass = r; }) });
  const m = mailer(transport);
  m.start();
  const pending = m.sendMail(GOOD);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 0);
  pass();
  assert.equal((await pending).status, 'sent');
});

test('close closes the transport once, and a closed mailer sends nothing', async () => {
  const { transport, sent } = scripted([]);
  const m = mailer(transport);
  await m.start();
  m.close(); m.close();
  assert.equal(transport.closed, true);
  assert.equal((await m.sendMail(GOOD)).code, 'MAIL_UNAVAILABLE');
  assert.equal(sent.length, 0);
});

test('every tag is a short lowercase word the logger accepts', () => {
  for (const tag of TAGS) assert.match(tag, /^[a-z_]{2,20}$/);
  const { lines, log } = capture();
  log.info('x', { tag: 'invite' }); log.info('y', { tag: MARKER });
  assert.match(lines[0], /tag="invite"/);
  assert.ok(!lines[1].includes('tag='));
});

// ---------- the dev transport ----------

test('the dev transport writes a private json and html pair, lists newest first, and reads back only its own ids', async () => {
  const dir = path.join(tmp(), 'outbox');
  let at = Date.parse('2026-10-06T10:00:00Z');
  const dev = createDevTransport({ dir, now: () => at });
  const m = createMailer({ config: loadConfig({}), secrets: loadSecrets({}), log: capture().log, clock: noSleep, transport: dev });
  const first = await m.sendMail({ ...GOOD, html: undefined, text: 'Plain <b>text</b> & more' });
  at += 1000;
  await m.sendMail({ ...GOOD, subject: 'Second' });
  assert.equal(first.status, 'sent');
  const list = dev.outbox.list();
  assert.deepEqual(list.map((x) => x.subject), ['Second', GOOD.subject]);
  assert.deepEqual(list[0].to, { name: 'Thandi', address: 'client@example.com' });
  const one = dev.outbox.read(list[1].id);
  assert.match(one.html, /Plain &lt;b&gt;text&lt;\/b&gt; &amp; more/, 'plain text is escaped into the html view');
  assert.equal(one.record.text, 'Plain <b>text</b> & more');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    for (const f of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
  }
  for (const bad of ['../rooms', '..%2Frooms', `${list[0].id}/../x`, '', null, 'x'.repeat(30)]) assert.equal(dev.outbox.read(bad), null, String(bad));
});

test('the dev outbox keeps only the newest 500 messages', async () => {
  const dir = tmp();
  let at = Date.parse('2026-01-01T00:00:00Z');
  const dev = createDevTransport({ dir, now: () => (at += 1000) });
  const msg = normalise(GOOD, { name: 'B', address: 'b@example.com' });
  for (let i = 0; i < 503; i++) await dev.send(msg);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 500);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.html')).length, 500);
  assert.equal(dev.outbox.list().length, 200);
});

test('an empty or missing outbox lists nothing', () => {
  assert.deepEqual(createDevTransport({ dir: path.join(tmp(), 'none') }).outbox.list(), []);
});

// ---------- the SMTP transport ----------

test('the SMTP options require TLS, check certificates, pool, time out every phase, and never touch files or URLs', () => {
  const plain = smtpOptions({ host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p' });
  assert.equal(plain.secure, false);
  assert.equal(plain.requireTLS, true, 'port 587 must upgrade with STARTTLS before AUTH');
  const tls = smtpOptions({ host: 'smtp.example.com', port: 465, secure: true, user: 'u', pass: 'p' });
  assert.equal(tls.secure, true);
  for (const o of [plain, tls]) {
    assert.equal(o.pool, true);
    assert.equal(o.tls.minVersion, 'TLSv1.2');
    assert.ok(!('rejectUnauthorized' in o.tls), 'certificates are always checked');
    for (const k of ['connectionTimeout', 'greetingTimeout', 'socketTimeout', 'dnsTimeout']) assert.ok(o[k] > 0 && o[k] <= 30000, k);
    assert.equal(o.disableFileAccess, true);
    assert.equal(o.disableUrlAccess, true);
    assert.equal(o.logger, false);
    assert.deepEqual(o.auth, { user: 'u', pass: 'p' });
  }
});

test('createSmtpTransport hands the options to nodemailer and maps verify, send and close', async () => {
  const calls = [];
  const fake = { createTransport(o) { calls.push(['create', o]); return { verify: async () => calls.push(['verify']), sendMail: async (m) => { calls.push(['send', m]); return { messageId: '<1>' }; }, close: () => calls.push(['close']) }; } };
  const t = createSmtpTransport({ nodemailer: fake, host: 'h.example.com', port: 587, secure: false, user: 'u', pass: 'p' });
  assert.equal(t.kind, 'smtp');
  await t.verify();
  assert.deepEqual(await t.send({ subject: 's' }), { messageId: '<1>' });
  t.close();
  assert.deepEqual(calls.map((c) => c[0]), ['create', 'verify', 'send', 'close']);
  assert.equal(calls[0][1].requireTLS, true);
});

// A server that offers no STARTTLS: a client that requires TLS must give up before it sends AUTH or anything else.
test('over a server without STARTTLS, the real transport refuses and never sends the credentials', async (t) => {
  const seen = [];
  const server = net.createServer((sock) => {
    sock.write('220 test ESMTP\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        seen.push(line);
        if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^HELO/i.test(line)) sock.write('250 test\r\n');
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); } else sock.write('502 no\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  const { lines, log } = capture();
  const m = createMailer({
    config: loadConfig({ ...SMTP_ENV, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port) }),
    secrets: loadSecrets({ SMTP_USER: 'user', SMTP_PASS: `pw-${MARKER}` }), log, clock: noSleep,
  });
  t.after(() => m.close());
  await m.start();
  assert.equal(m.status(), 'unavailable');
  assert.ok(seen.some((l) => /^EHLO/i.test(l)), seen.join('|'));
  assert.ok(!seen.some((l) => /^AUTH|^MAIL|^RCPT/i.test(l) || l.includes(Buffer.from(`pw-${MARKER}`).toString('base64')) || l.includes(MARKER)), seen.join('|'));
  assert.match(lines.join(''), /event="mail.verify_failed" status="smtp"/);
  assert.ok(!lines.join('').includes(MARKER));
});
