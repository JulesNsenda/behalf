'use strict';
// The connect page's one line for a signed-in person who has not been approved to use our AI, and the header's Admin link on the pages that
// fill the slot. The real account.js and connect.js against a fake page and a scripted /api/me.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadPage, ok, refused, ME } = require('../test-support/fake-page');

const ON = { live: true, passcode: false, signin: 'github' };

async function open(me, over) {
  let current = me;
  const page = loadPage({
    config: ON,
    request: (method, url) => (url === '/api/me' ? ok(200, JSON.parse(JSON.stringify(current))) : refused(404)),
    ...over,
  });
  await page.flush();
  return { page, set: (m) => { current = m; } };
}

const LINE = 'Our AI needs approval first. <a href="/start">Ask for it on the start page.</a>';

test('connect: a signed-in person who has not asked yet gets one line that sends them to the start page', async () => {
  const { page } = await open(ME({ ai: 'none' }));
  assert.equal(page.el('ai-access-line').hidden, false);
  assert.equal(page.html('ai-access-line'), LINE);
});

test('connect: no line for someone who already asked or was turned down', async () => {
  for (const ai of ['requested', 'denied']) {
    const { page } = await open(ME({ ai }));
    assert.equal(page.el('ai-access-line').hidden, true, ai);
    assert.equal(page.html('ai-access-line'), '', ai);
  }
});

test('connect: no line for a person with access, an admin, someone signed out, sign-in off, or a server with no built-in AI', async () => {
  for (const [name, me, over] of [
    ['granted', ME({ ai: 'granted' })],
    ['admin', ME({ ai: 'granted', admin: true })],
    ['admin, status none', ME({ ai: 'none', admin: true })],
    ['signed out', ME({ user: null })],
    ['sign-in off', ME({ user: null }), { config: { live: true, passcode: false, signin: 'off' } }],
    ['no built-in AI', ME(), { config: { live: false, passcode: false, signin: 'github' } }],
    ['settings unreadable', ME(), { config: null }],
  ]) {
    const { page } = await open(me, over);
    assert.equal(page.el('ai-access-line').hidden, true, name);
    assert.equal(page.html('ai-access-line'), '', name);
  }
});

test('connect: the line follows the answer: gone after a grant, back after the approval is taken back, and a sign-out takes it away', async () => {
  const { page, set } = await open(ME());
  assert.equal(page.el('ai-access-line').hidden, false);
  set(ME({ ai: 'granted' }));
  await page.window.Account.refresh();
  assert.equal(page.el('ai-access-line').hidden, true);
  set(ME({ ai: 'none' }));
  await page.window.Account.refresh();
  assert.equal(page.el('ai-access-line').hidden, false);
  set(ME({ user: null }));
  await page.window.Account.refresh();
  assert.equal(page.el('ai-access-line').hidden, true);
});

test('connect: the line does not touch the key panel or the command', async () => {
  const { page } = await open(ME());
  assert.ok(page.byId('key-create'), 'the key panel is as it was');
  assert.equal(page.command(), 'claude mcp add --transport http behalf https://behalf.test/mcp');
});

test('the header slot shows an Admin link before Sign out for an admin on any page that fills it, and for nobody else', async () => {
  for (const pathname of ['/', '/connect', '/spec']) {
    const admin = await open(ME({ ai: 'granted', admin: true }), { scripts: ['account.js'], pathname });
    assert.ok(admin.page.slotHtml().includes('<a class="btn btn--link" id="account-admin" href="/admin">Admin</a>'), pathname);
    assert.ok(admin.page.slotHtml().indexOf('id="account-admin"') < admin.page.slotHtml().indexOf('id="sign-out"'), pathname);
    for (const me of [ME(), ME({ ai: 'granted' }), ME({ user: null })]) {
      const other = await open(me, { scripts: ['account.js'], pathname });
      assert.ok(!other.page.slotHtml().includes('/admin'), pathname + ' ' + JSON.stringify(me));
    }
  }
});

test('the Admin link comes and goes with the answer', async () => {
  const { page, set } = await open(ME(), { scripts: ['account.js'], pathname: '/' });
  assert.ok(!page.slotHtml().includes('account-admin'));
  set(ME({ ai: 'granted', admin: true }));
  await page.window.Account.refresh();
  assert.ok(page.slotHtml().includes('account-admin'));
  set(ME({ ai: 'granted' }));
  await page.window.Account.refresh();
  assert.ok(!page.slotHtml().includes('account-admin'));
});
