'use strict';
// The dev outbox page in-process: listed and readable off the platform, a 404 everywhere else, and every value escaped.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { loadConfig, loadSecrets } = require('../lib/config');
const { fakeProxy, quietLog } = require('../test-support/app');
const { mkTmp, rmTmp } = require('../test-support/server');

const T = { timeout: 30000 };

async function boot(t, env) {
  const dir = mkTmp('mail-http-');
  const config = { ...loadConfig({ SIGNIN: 'off', PUBLIC_URL: 'http://localhost:3000', ...env }), dataDir: path.join(dir, 'data') };
  const app = createApp({ config, secrets: loadSecrets({}), log: quietLog(), proxy: fakeProxy(), clock: { sleep: async () => {} }, file: path.join(dir, 'data', 'rooms.json') });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.drain().catch(() => {});
    if (app.server.closeAllConnections) app.server.closeAllConnections();
    app.close();
    rmTmp(dir);
  });
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

const MSG = { to: 'client@example.com', toName: 'Thandi <script>', subject: 'Confirm <3> things & more', text: 'Hi', html: '<p style="color:#123">Hi</p>', tag: 'test' };

test('off the platform, /dev/outbox lists each email (escaped) and shows it with its own sandboxed policy', T, async (t) => {
  const { app, base } = await boot(t, {});
  const sent = await app.mailer.sendMail(MSG);
  assert.equal(sent.status, 'sent');
  const list = await fetch(base + '/dev/outbox');
  assert.equal(list.status, 200);
  assert.match(list.headers.get('content-type'), /^text\/html/);
  assert.match(list.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const page = await list.text();
  assert.match(page, /Confirm &lt;3&gt; things &amp; more/);
  assert.match(page, /Thandi &lt;script&gt;/);
  assert.ok(!page.includes('<script>'));
  const id = page.match(/href="\/dev\/outbox\/([^".]+)"/)[1];

  const one = await fetch(`${base}/dev/outbox/${id}`);
  assert.equal(one.status, 200);
  const csp = one.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /sandbox/);
  assert.ok(!/script-src/.test(csp), 'no script may run in an email view');
  assert.equal(await one.text(), MSG.html);

  const json = await (await fetch(`${base}/dev/outbox/${id}.json`)).json();
  assert.equal(json.subject, MSG.subject);
  assert.deepEqual(json.to, { name: 'Thandi <script>', address: 'client@example.com' });

  for (const bad of ['/dev/outbox/../rooms.json', '/dev/outbox/%2e%2e%2frooms', '/dev/outbox/nope', '/dev/outbox/nope.json']) {
    assert.equal((await fetch(base + bad)).status, 404, bad);
  }
  assert.equal((await fetch(base + '/dev/outbox', { method: 'POST' })).status, 404);
});

test('on the platform there is no outbox page, though the dev transport still writes', T, async (t) => {
  const { app, base } = await boot(t, { DROP_DATA_DIR: '/unused' });
  assert.equal((await app.mailer.sendMail(MSG)).status, 'sent');
  assert.equal(app.mailer.outbox.list().length, 1);
  for (const url of ['/dev/outbox', `/dev/outbox/${app.mailer.outbox.list()[0].id}`]) assert.equal((await fetch(base + url)).status, 404, url);
});

test('/health reports the mail transport and whether it is ready', T, async (t) => {
  const { app, base } = await boot(t, {});
  await app.mailer.start();
  const h = await (await fetch(base + '/health')).json();
  assert.equal(h.mail, 'dev');
  assert.equal(h.mailOk, true);
});

// scripts/send-test-mail.js, spawned: one line out, the right exit code, and nothing secret on the console.
test('the test-mail script sends one email through the dev transport, and refuses bad settings with a code', T, async (t) => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const { ROOT } = require('../test-support/paths');
  const dir = mkTmp('mail-script-');
  t.after(() => rmTmp(dir));
  const run = (args, env) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'send-test-mail.js'), ...args], { env: { PATH: process.env.PATH, SIGNIN: 'off', DROP_DATA_DIR: dir, ...env }, encoding: 'utf8' });
  const ok = run(['me@example.com'], {});
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^sent <[^>]+@outbox\.behalf>\n$/);
  assert.equal(fs.readdirSync(path.join(dir, 'outbox')).length, 2);
  assert.equal(run([], {}).status, 2);
  const bad = run(['me@example.com'], { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'h.example.com', SMTP_PORT: '587', MAIL_FROM: 'a@example.com', SMTP_USER: 'u', SMTP_PASS: '' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /failed BAD_SMTP_AUTH/);
  const refused = run(['me@example.com'], { MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '9', MAIL_FROM: 'a@example.com', SMTP_USER: 'u', SMTP_PASS: 'pw-SECRET' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /mail\.verify_failed/);
  assert.ok(!(refused.stdout + refused.stderr).includes('pw-SECRET'));
});
