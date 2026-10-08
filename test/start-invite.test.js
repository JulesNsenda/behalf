'use strict';
// The real account.js and start.js against a small fake of the start page: the optional "Their email" field on the invite step, shown
// only when the server says an invite can be emailed, what it posts, and what the person reads back. (The room's own creation flow is in
// test/start-page.test.js and test/start-access.test.js.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadPage, ok, refused, ME } = require('../test-support/fake-page');
const { WEB } = require('../test-support/paths');

const ON = { live: true, passcode: false, signin: 'github', invite: true };
const OFF = { live: true, passcode: false, signin: 'github', invite: false };
const ROOM = { id: 'r1', links: { A: '/room/r1?seat=A&t=ta', B: '/room/r1?seat=B&t=tb' } };
const INVITE_URL = '/api/rooms/r1/seats/A/invite';
const HOSTILE = '"><img src=x onerror=alert(1)>@x.test';

// The start page with the room made, so the invite step is showing. invite: how the server answers the invite (default 202).
async function onInviteStep({ config = ON, invite = () => ok(202, { status: 'queued' }) } = {}) {
  const page = loadPage({
    config, pathname: '/start', lazy: true, scripts: ['account.js', 'start.js'],
    hidden: ['start-form', 'signin-view', 'step-label', 'ai-access'],
    request: (method, url, body) => {
      if (url === '/api/me') return ok(200, ME({ ai: 'granted' }));
      if (method === 'POST' && url === '/api/rooms') return ok(201, ROOM);
      if (method === 'POST' && url === INVITE_URL) return invite(body);
      return refused(404);
    },
  });
  await page.flush();
  page.el('topic').value = 'the thing'; page.el('you').value = 'Ann'; page.el('them').value = 'Bob';
  page.el('start-form').fire('submit', { preventDefault() {} });
  await page.flush();
  page.sendTo = async (address) => {
    page.el('invite-email').value = address;
    page.el('invite-send').click();
    await page.flush();
  };
  page.invites = () => page.requests.filter((r) => r.url === INVITE_URL);
  return page;
}

test('the email field is hidden when the server cannot send invites, and the link flow is as it was', async () => {
  const p = await onInviteStep({ config: OFF });
  const h = p.html('invite-view');
  assert.ok(h.includes('id="invite-link"') && h.includes('id="own-link"'), 'the copy-link flow is still there');
  assert.ok(!h.includes('invite-email') && !h.includes('invite-send') && !h.includes('Their email'));
});

test('the email field is shown when the server can send invites: an email input with autocomplete, and a Send invite button', async () => {
  const p = await onInviteStep();
  const h = p.html('invite-view');
  assert.ok(h.includes('<label class="field__label" for="invite-email">Their email</label>'));
  assert.ok(/<input class="input" id="invite-email" type="email"[^>]*autocomplete="email"/.test(h), h);
  assert.ok(h.includes('id="invite-send">Send invite</button>') && h.includes('type="button" id="invite-send"'), 'a button that does not submit anything');
  assert.ok(h.includes('id="invite-link"') && h.includes('id="own-link"'), 'the copy-link flow is still there');
  assert.equal(p.invites().length, 0, 'nothing is sent until asked');
});

test('Send invite posts seat A\'s token and the address, says it is sending, then says it was sent with the address escaped', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = await onInviteStep({ invite: async () => { await gate; return ok(202, { status: 'queued' }); } });
  p.el('invite-email').value = '  bob@example.com ';
  p.el('invite-send').click();
  await p.flush();
  assert.deepStrictEqual(p.invites().map((r) => [r.method, r.body]), [['POST', { token: 'ta', email: 'bob@example.com' }]]);
  assert.ok(p.html('invite-status').includes('Sending to bob@example.com…'), p.html('invite-status'));
  assert.equal(p.el('invite-send').busy, true);
  release();
  await p.flush();
  assert.ok(p.html('invite-status').includes('Invite sent to bob@example.com.'), p.html('invite-status'));
  assert.equal(p.el('invite-send').busy, false);
  assert.ok(!p.html('invite-view').includes('bob@example.com'), 'the address is not in the page markup, only in the status');
});

test('a hostile address is escaped in both the sending and the sent text', async () => {
  const p = await onInviteStep();
  await p.sendTo(HOSTILE);
  const h = p.html('invite-status');
  assert.ok(h.includes('Invite sent to'), h);
  assert.ok(!h.includes('<img') && !h.includes('"><'), h);
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'), h);
});

test('while an invite is out, a second click sends nothing more; an empty address is asked for, not sent', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = await onInviteStep({ invite: async () => { await gate; return ok(202, {}); } });
  await p.sendTo('');
  assert.equal(p.invites().length, 0);
  assert.deepStrictEqual(p.fieldErrors.slice(-1), [['invite-email', 'Enter their email address.']]);
  await p.sendTo('bob@example.com');
  p.el('invite-send').click();
  await p.flush();
  assert.equal(p.invites().length, 1);
  release();
  await p.flush();
});

test('Enter in the field sends the invite', async () => {
  const p = await onInviteStep();
  p.el('invite-email').value = 'bob@example.com';
  p.el('invite-email').fire('keydown', { key: 'Enter', preventDefault() {} });
  await p.flush();
  assert.equal(p.invites().length, 1);
});

test('every refusal reads as its own sentence, from room-view.js, and never the server\'s text', async () => {
  const RV = require('../web/js/room-view.js');
  const cases = [[400], [403], [404], [409], [401, 'signin_required'], [403, 'origin'], [415, 'content_type'], [429, 'invite_limit'], [429, 'invite_address_limit'], [429, 'invite_daily_limit'], [503, 'mail_off'], [503, 'saving_unavailable'], [0]];
  const seen = new Set();
  for (const [status, code] of cases) {
    const p = await onInviteStep({ invite: () => refused(status, code) });
    await p.sendTo('bob@example.com');
    const want = RV.errorMessage('invite', status, code);
    const h = p.html('invite-status');
    assert.ok(h.includes(want), `${status} ${code}: ${h}`);
    assert.ok(!h.includes('text from the server'), h);
    assert.equal(p.el('invite-send').busy, false, 'the button is usable again');
    seen.add(want);
  }
  assert.ok(seen.size >= 12, 'distinct sentences: ' + seen.size);
});

test('a failed invite can be tried again', async () => {
  let n = 0;
  const p = await onInviteStep({ invite: () => (++n === 1 ? refused(0) : ok(202, {})) });
  await p.sendTo('bob@example.com');
  assert.ok(!p.html('invite-status').includes('Invite sent'));
  await p.sendTo('bob@example.com');
  assert.ok(p.html('invite-status').includes('Invite sent to bob@example.com.'));
});

test('start.js stays free of inline code and string-to-HTML sinks', () => {
  const src = fs.readFileSync(path.join(WEB, 'js', 'start.js'), 'utf8');
  assert.ok(!/\binnerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(/.test(src));
  const page = fs.readFileSync(path.join(WEB, 'start.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)|\son[a-z]+\s*=|style\s*=/i.test(page));
});

test('after a successful send the field and button are cleared and disabled, and Enter or a click sends nothing more', async () => {
  const p = await onInviteStep();
  await p.sendTo('bob@example.com');
  assert.equal(p.invites().length, 1);
  assert.ok(p.html('invite-status').includes('Invite sent to bob@example.com.'));
  assert.equal(p.el('invite-email').value, '');
  assert.equal(p.el('invite-email').disabled, true);
  assert.equal(p.el('invite-send').disabled, true);
  p.el('invite-email').value = 'carol@example.com';
  p.el('invite-email').fire('keydown', { key: 'Enter', preventDefault() {} });
  p.el('invite-send').click();
  await p.flush();
  assert.equal(p.invites().length, 1, 'one send per page view');
  assert.ok(p.html('invite-view').includes('id="invite-link"'), 'the copy-link flow is still there');
});

test('the invite email wording comes from room-view.js', () => {
  const RV = require('../web/js/room-view.js');
  assert.deepStrictEqual(RV.inviteEmailText('Bob'), {
    label: 'Their email',
    hint: "Optional. We'll email Bob their link. You can still copy it above.",
    send: 'Send invite',
    empty: 'Enter their email address.'
  });
  assert.equal(RV.inviteSending('a@b.test'), 'Sending to a@b.test…');
  assert.equal(RV.inviteSent('a@b.test'), 'Invite sent to a@b.test.');
  assert.ok(/enough invitations/.test(RV.errorMessage('invite', 429, 'invite_address_limit')));
  assert.ok(/this room/.test(RV.errorMessage('invite', 429, 'invite_limit')));
  assert.ok(/Try again in a minute/.test(RV.errorMessage('invite', 503, 'saving_unavailable')));
});

test('start.js holds none of the invite email wording', () => {
  const src = fs.readFileSync(path.join(WEB, 'js', 'start.js'), 'utf8');
  for (const w of ['Their email', 'Send invite', 'Enter their email', 'Sending to', 'Invite sent', 'Optional.']) assert.ok(!src.includes(w), w);
  assert.ok(!/searchParams\.get\('t'\)/.test(src), 'the token comes from Links.tokenOf');
});
