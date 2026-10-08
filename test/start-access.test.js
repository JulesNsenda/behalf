'use strict';
// The real account.js and start.js, run against a small fake of the start page: what a person who may not use our AI sees ("Use our AI"
// block, the card switched off, both seats sent as their own AI), how a request for access goes, and that everyone else is unchanged.
// (The sign-in prompt and the form's own refusals are in test/start-page.test.js.)
const { test } = require('node:test');
const assert = require('node:assert');
const { loadPage, flush, ok, refused, ME } = require('../test-support/fake-page');

const ON = { live: true, passcode: false, signin: 'github' };
const ROOM = { id: 'r1', links: { A: '/room/r1?seat=A&t=ta', B: '/room/r1?seat=B&t=tb' } };
const NOTE = 'note-1';
const SAME = (v) => JSON.parse(JSON.stringify(v));

// The start page: account.js and start.js against a scripted server. me: the /api/me answer (a function, to change it between calls);
// request: replaces the whole server, otherwise /api/me answers me and POST /api/rooms answers create.
function gated(me, { config, meFails, create, request } = {}) {
  const page = loadPage({
    config: config || ON, pathname: '/start', lazy: true, scripts: ['account.js', 'start.js'],
    hidden: ['start-form', 'signin-view', 'step-label', 'ai-access'], // all start hidden, as in start.html
    request: request || ((method, url, body) => {
      if (url === '/api/me') return meFails ? refused(500) : ok(200, SAME(typeof me === 'function' ? me() : me));
      if (method === 'POST' && url === '/api/rooms') return (create || (() => ok(201, ROOM)))(body);
      return refused(404);
    }),
  });
  page.errorHtml = () => page.html('form-error');
  page.submit = async () => {
    page.el('topic').value = 'the thing'; page.el('you').value = 'Ann'; page.el('them').value = 'Bob';
    page.el('start-form').fire('submit', { preventDefault() {} });
    await flush();
  };
  return page;
}

const block = (p) => p.html('ai-access');
const createBody = (p) => p.requests.find((r) => r.method === 'POST' && r.url === '/api/rooms').body;
const modes = (p) => [createBody(p).modeA, createBody(p).modeB];
const asks = (p) => p.requests.filter((r) => r.url === '/api/me/ai-access');
// A server for the request flow: /api/me says "none", and the request is answered by reply.
const asking = (reply) => (m, u) => (u === '/api/me' ? ok(200, ME()) : m === 'POST' && u === '/api/me/ai-access' ? reply(m, u) : refused(404));

test('without access (none): the Our AI card is off and points at the block, My own AI is chosen, and the block asks for access outside the card', async () => {
  const p = gated(ME());
  assert.equal(p.el('ai-access').hidden, true, 'hidden until the page decides');
  await p.flush();
  assert.equal(p.el('start-form').hidden, false);
  assert.equal(p.el('ai-builtin').disabled, true);
  assert.equal(p.el('ai-own').checked, true);
  assert.ok(p.el('ai-builtin').getAttribute('aria-describedby').includes('ai-access-lead'), 'the card is described by the block');
  assert.equal(p.el('ai-builtin-hint').textContent, 'Needs approval first. You can ask below.');
  assert.equal(p.el('ai-access').hidden, false);
  const h = block(p);
  assert.ok(h.includes('<h2 class="card__title">Use our AI</h2>'));
  assert.ok(h.includes('id="ai-access-lead"') && h.includes('Our AI needs approval first.'));
  assert.ok(h.includes('<label class="field__label" for="ai-note">A short note (optional)</label>') && h.includes('<textarea class="textarea" id="ai-note"'));
  assert.ok(h.includes('<button class="btn btn--secondary" type="button" id="ai-request">Request access</button>'), 'a button that does not submit the form');
  assert.equal(p.el('other-hint').textContent, 'The other person will use their own AI agent too.');
  assert.equal(p.focused, null, 'nothing grabs the focus on load');
});

test('without access: the room is made with both seats as their own AI, whatever the card said', async () => {
  const p = gated(ME());
  await p.flush();
  p.el('ai-builtin').checked = true; // even if something checked it
  await p.submit();
  assert.deepStrictEqual(modes(p), ['external', 'external']);
  assert.equal(p.requests.filter((r) => r.url === '/api/rooms').length, 1);
});

test('without access: the invite says the other person uses their own AI, by name', async () => {
  const p = gated(ME());
  await p.flush();
  await p.submit();
  assert.ok(p.html('invite-view').includes('Bob will use their own AI agent. Their link shows how to connect it.'), p.html('invite-view'));
});

test('requested and denied: only the sentence, no note field and no button, the card says the same, and the room is still their own AI on both sides', async () => {
  const requested = gated(ME({ ai: 'requested' }));
  await requested.flush();
  assert.ok(block(requested).includes("Requested. Refresh this page after it's approved."));
  assert.ok(!block(requested).includes('ai-note') && !block(requested).includes('ai-request'));
  assert.equal(requested.el('ai-builtin-hint').textContent, 'Waiting for approval.');
  assert.equal(requested.el('ai-builtin').disabled, true);
  const denied = gated(ME({ ai: 'denied' }));
  await denied.flush();
  assert.ok(block(denied).includes('Not available for your account.'));
  assert.ok(!block(denied).includes('ai-request'));
  assert.equal(denied.el('ai-builtin-hint').textContent, 'Not available for your account.');
  await denied.submit();
  assert.deepStrictEqual(modes(denied), ['external', 'external']);
});

test('with access (granted or an admin), sign-in off, no built-in AI, signed out, or /api/me unreadable: the block stays away and the other person is not told to bring their own', async () => {
  for (const [name, p, expectDescribed] of [
    ['granted', gated(ME({ ai: 'granted' })), ''],
    ['admin', gated(ME({ ai: 'granted', admin: true })), ''],
    ['admin whose status is none', gated(ME({ ai: 'none', admin: true })), ''],
    ['sign-in off', gated(ME({ user: null }), { config: { live: true, passcode: false, signin: 'off' } }), ''],
    ['no built-in AI', gated(ME(), { config: { live: false, passcode: false, signin: 'github' } }), 'ai-builtin-hint'],
    ['signed out', gated(ME({ user: null })), ''],
    ['/api/me unreadable', gated(ME(), { meFails: true }), ''],
  ]) {
    await p.flush();
    assert.equal(p.el('ai-access').hidden, true, name);
    assert.equal(block(p), '', name);
    assert.equal(p.el('ai-builtin').getAttribute('aria-describedby') || '', expectDescribed, name);
    assert.notEqual(p.el('other-hint').textContent, 'The other person will use their own AI agent too.', name);
  }
});

test('with access the room is made as it always was; sign-in off and no built-in AI are unchanged too', async () => {
  const granted = gated(ME({ ai: 'granted' }));
  await granted.flush();
  assert.equal(granted.el('ai-builtin').disabled, false);
  granted.el('ai-builtin').checked = true;
  await granted.submit();
  assert.deepStrictEqual(modes(granted), ['builtin', 'builtin']);
  assert.ok(!granted.html('invite-view').includes('will use their own AI agent'));

  const own = gated(ME({ ai: 'granted' }));
  await own.flush();
  await own.submit(); // "My own AI" left chosen
  assert.deepStrictEqual(modes(own), ['external', 'builtin']);

  const admin = gated(ME({ ai: 'none', admin: true }));
  await admin.flush();
  admin.el('ai-builtin').checked = true;
  await admin.submit();
  assert.deepStrictEqual(modes(admin), ['builtin', 'builtin']);

  const off = gated(ME({ user: null }), { config: { live: true, passcode: false, signin: 'off' } });
  await off.flush();
  off.el('ai-builtin').checked = true;
  await off.submit();
  assert.deepStrictEqual(modes(off), ['builtin', 'builtin']);

  const none = gated(ME(), { config: { live: false, passcode: false, signin: 'github' } });
  await none.flush();
  await none.submit();
  assert.deepStrictEqual(modes(none), ['external', 'external']);
});

test('Request access sends the trimmed note as JSON, then shows Requested with the focus on the sentence; the form is untouched', async () => {
  const p = gated(null, { request: asking(() => ok(200, { status: 'requested' })) });
  await p.flush();
  p.el('ai-note').value = '  ' + NOTE + '  ';
  p.el('topic').value = 'kept';
  p.el('ai-request').click();
  await p.flush();
  assert.deepStrictEqual(asks(p), [{ method: 'POST', url: '/api/me/ai-access', body: { note: NOTE } }]);
  const h = block(p);
  assert.ok(h.includes('Requested.') && !h.includes('ai-request') && !h.includes('ai-note'));
  assert.equal(p.focused, 'ai-access-lead');
  assert.equal(p.el('ai-builtin-hint').textContent, 'Waiting for approval.');
  assert.equal(p.el('ai-builtin').disabled, true);
  assert.equal(p.el('topic').value, 'kept');
  assert.equal(p.requests.filter((r) => r.url === '/api/rooms').length, 0, 'the form was not submitted');
});

test('a request with no note sends an empty one', async () => {
  const p = gated(null, { request: asking(() => ok(200, { status: 'requested' })) });
  await p.flush();
  p.el('ai-request').click();
  await p.flush();
  assert.deepStrictEqual(asks(p).map((r) => r.body), [{ note: '' }]);
});

test('a request answered "denied" shows its sentence; one answered "granted" gives the card back and the form uses our AI', async () => {
  const denied = gated(null, { request: asking(() => ok(200, { status: 'denied' })) });
  await denied.flush();
  denied.el('ai-request').click();
  await denied.flush();
  assert.ok(block(denied).includes('Not available for your account.'));
  assert.equal(denied.el('ai-builtin').disabled, true);

  const granted = gated(null, { request: asking(() => ok(200, { status: 'granted' })) });
  await granted.flush();
  granted.el('ai-request').click();
  await granted.flush();
  assert.equal(granted.el('ai-builtin').disabled, false);
  assert.equal(granted.el('ai-access').hidden, true);
  assert.equal(block(granted), '');
  assert.notEqual(granted.el('ai-builtin-hint').textContent, 'Waiting for approval.');
  assert.equal(granted.el('ai-builtin').getAttribute('aria-describedby') || '', '', 'the card no longer points at a block that is gone');
  assert.notEqual(granted.el('other-hint').textContent, 'The other person will use their own AI agent too.');
  granted.el('ai-builtin').checked = true;
  await granted.submit();
  assert.deepStrictEqual(modes(granted), ['builtin', 'builtin']);
});

test('an answer that is not a status counts as requested', async () => {
  const p = gated(null, { request: asking(() => ok(200, { status: 'surprise' })) });
  await p.flush();
  p.el('ai-request').click();
  await p.flush();
  assert.ok(block(p).includes('Requested.'));
});

test('a refused request shows its own sentence in the block, keeps the note that was typed and puts the focus back on the button', async () => {
  for (const [res, text] of [
    [refused(429, 'rate_limited'), "You've asked a few times already."],
    [refused(503, 'requests_full'), "We can't take more requests right now."],
    [refused(401, 'signin_required'), 'Your sign-in has ended.'],
    [refused(400, 'ai_note'), "Your note can't be sent as it is."],
    [refused(403, 'origin'), 'Please reload the page and try again.'],
    [{ ok: false, status: 0, data: {} }, "couldn't reach the server"],
    [refused(500), "We couldn't send your request."],
  ]) {
    const p = gated(null, { request: asking(() => res) });
    await p.flush();
    p.el('ai-note').value = 'my note';
    p.el('ai-request').click();
    await p.flush();
    const h = block(p);
    assert.ok(h.includes('role="alert"') && h.includes(text), text + ' / ' + h);
    assert.ok(!h.includes('text from the server'));
    assert.equal(p.el('ai-note').value, 'my note', 'the note is still there');
    assert.ok(h.includes('id="ai-request"'), 'the button is still there to try again');
    assert.equal(p.focused, 'ai-request');
    assert.equal(p.el('ai-builtin').disabled, true);
  }
});

test('one request at a time: a second click while the first is out sends nothing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = gated(null, { request: asking(() => gate.then(() => ok(200, { status: 'requested' }))) });
  await p.flush();
  const button = p.el('ai-request');
  button.click();
  button.click();
  await p.flush();
  assert.equal(asks(p).length, 1);
  assert.equal(button.busy, true);
  release();
  await p.flush();
  assert.equal(asks(p).length, 1);
});

test('a room refused with 403 ai_access (approval was taken back since the page loaded): the banner says why, and the form turns into the without-access one', async () => {
  let me = ME({ ai: 'granted' });
  const p = gated(() => me, { create: () => refused(403, 'ai_access') });
  await p.flush();
  assert.equal(p.el('ai-access').hidden, true, 'granted when the page loaded');
  me = ME({ ai: 'none' });
  await p.submit();
  assert.ok(p.errorHtml().includes('Our AI needs approval first. Ask for access below, or use your own AI agent.'));
  assert.equal(p.fieldErrors.filter(([id, m]) => id === 'pass' && m).length, 0, 'not the passcode');
  assert.equal(p.el('ai-builtin').disabled, true);
  assert.equal(p.el('ai-access').hidden, false);
  assert.ok(block(p).includes('id="ai-request"'));
  assert.equal(p.el('start-form').hidden, false);
});

test('the note a person types is never put into markup: it is read from the field, sent, and not echoed back anywhere', async () => {
  const hostile = '<img src=x onerror=alert(1)> https://evil.test';
  const p = gated(null, { request: asking(() => refused(400, 'ai_note')) });
  await p.flush();
  p.el('ai-note').value = hostile;
  p.el('ai-request').click();
  await p.flush();
  assert.ok(!block(p).includes('onerror') && !block(p).includes('evil.test'), 'only the property holds it');
  assert.equal(p.el('ai-note').value, hostile);
  assert.deepStrictEqual(asks(p)[0].body, { note: hostile });
});

test('the passcode field is only for a server that asks: a signed-in person on a server with sign-in on is not asked (the settings say passcode false)', async () => {
  const p = gated(ME({ ai: 'granted' }), { config: { live: true, passcode: false, signin: 'github' } });
  await p.flush();
  assert.equal(p.el('pass-field').hidden, true);
  await p.submit();
  assert.equal(p.fieldErrors.filter(([id, m]) => id === 'pass' && m).length, 0);
  assert.equal(p.requests.filter((r) => r.url === '/api/rooms').length, 1, 'no passcode was needed to submit');
  const asked = gated(ME({ ai: 'granted' }), { config: { live: true, passcode: true, signin: 'off' } });
  await asked.flush();
  assert.equal(asked.el('pass-field').hidden, false, 'sign-in off with a passcode is unchanged');
});
