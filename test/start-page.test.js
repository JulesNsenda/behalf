'use strict';
// The real account.js and start.js, run against a small fake of the start page and a scripted server: which of the form and the sign-in
// prompt a person sees in each state (signed out, signed in, ?signin=failed, a create refused with 401), where the focus goes, and which
// requests were made. (Static pins live in pages.test.js; the connect page and the header slot are in page-scripts.test.js.)
const { test } = require('node:test');
const assert = require('node:assert');
const { loadPage, flush, ok, refused, ME } = require('../test-support/fake-page');
const AccountView = require('../web/js/account-view.js');
const RoomView = require('../web/js/room-view.js');

// The start page: account.js and start.js against a scripted server (me: the /api/me answer, create: what POST /api/rooms answers).
function loadStart({ config, me, meFails, create, search }) {
  const page = loadPage({
    config, search, pathname: '/start', lazy: true, scripts: ['account.js', 'start.js'],
    request: (method, url, body) => {
      if (url === '/api/me') return meFails ? refused(500) : ok(200, JSON.parse(JSON.stringify(me)));
      if (method === 'POST' && url === '/api/rooms') return create(body);
      return refused(404);
    },
  });
  page.signinHtml = () => page.html('signin-view');
  page.errorHtml = () => page.html('form-error');
  page.submit = async (names) => {
    page.el('topic').value = 'the thing'; page.el('you').value = (names && names.you) || 'Ann'; page.el('them').value = 'Bob';
    page.el('start-form').fire('submit', { preventDefault() {} });
    await flush();
  };
  return page;
}

const ON = { live: true, passcode: false, signin: 'github' };
const formShown = (p) => p.el('start-form').hidden === false;
const promptShown = (p) => p.el('signin-view').hidden === false && p.signinHtml().includes('id="signin-link"');

test('signed out with sign-in on: the form is replaced by the sign-in link back to /start and a way to watch the demo, with no notice and no focus grab', async () => {
  const page = loadStart({ config: ON, me: ME({ user: null }) });
  await page.flush();
  assert.equal(formShown(page), false);
  assert.ok(promptShown(page));
  assert.ok(page.signinHtml().includes('href="/auth/github?next=/start"'));
  assert.ok(page.signinHtml().includes('href="/#demo"'));
  assert.ok(!page.signinHtml().includes('role="alert"') && !page.signinHtml().includes(AccountView.SIGNIN_FAILED));
  assert.equal(page.focused, null);
  assert.equal(page.meRequests(), 1);
});

test('signed in: the form stays, and the sign-in prompt stays hidden and empty', async () => {
  const page = loadStart({ config: ON, me: ME() });
  await page.flush();
  assert.equal(formShown(page), true);
  assert.equal(page.signinHtml(), '');
  assert.equal(page.meRequests(), 1);
  assert.deepStrictEqual(page.replaced, []);
});

test('?signin=failed, signed out: the failure sentence is above the sign-in link, and the address is tidied to /start', async () => {
  const page = loadStart({ config: ON, me: ME({ user: null }), search: '?signin=failed' });
  await page.flush();
  assert.ok(promptShown(page));
  assert.ok(page.signinHtml().includes(AccountView.SIGNIN_FAILED));
  assert.ok(page.signinHtml().indexOf(AccountView.SIGNIN_FAILED) < page.signinHtml().indexOf('id="signin-link"'));
  assert.deepStrictEqual(page.replaced, ['/start']);
});

test('?signin=failed with a session already there: the form shows, with the failure sentence in its banner', async () => {
  const page = loadStart({ config: ON, me: ME(), search: '?signin=failed' });
  await page.flush();
  assert.equal(formShown(page), true);
  assert.equal(page.signinHtml(), '');
  assert.ok(page.errorHtml().includes(AccountView.SIGNIN_FAILED));
  assert.deepStrictEqual(page.replaced, ['/start']);
});

test('only exactly signin=failed counts', async () => {
  for (const search of ['?signin=ok', '?signin=', '?signin=FAILED', '?x=signin=failed', '']) {
    const page = loadStart({ config: ON, me: ME(), search });
    await page.flush();
    assert.deepStrictEqual(page.replaced, [], search);
    assert.equal(page.errorHtml(), '', search);
  }
});

test('sign-in off: no /api/me request, the form shows, and ?signin=failed is still said in the banner', async () => {
  const off = { live: true, passcode: false, signin: 'off' };
  const page = loadStart({ config: off, me: ME({ user: null }) });
  await page.flush();
  assert.equal(formShown(page), true);
  assert.equal(page.signinHtml(), '');
  assert.deepStrictEqual(page.requests, []);
  const failed = loadStart({ config: off, me: ME({ user: null }), search: '?signin=failed' });
  await failed.flush();
  assert.deepStrictEqual(failed.requests, []);
  assert.ok(failed.errorHtml().includes(AccountView.SIGNIN_FAILED));
});

test('fails open: settings that cannot be read, or an /api/me that cannot be, leave the form and ask nothing more', async () => {
  const noConfig = loadStart({ config: null, me: ME({ user: null }) });
  await noConfig.flush();
  assert.equal(formShown(noConfig), true);
  const noMe = loadStart({ config: ON, me: ME({ user: null }), meFails: true });
  await noMe.flush();
  assert.equal(formShown(noMe), true, 'a failed read is not "signed out"');
  assert.equal(noMe.signinHtml(), '');
});

test('a create refused with 401 signin_required (the session ended after the page loaded): the sign-in takes the form\'s place with the sentence, and the focus goes to its link', async () => {
  const page = loadStart({ config: ON, me: ME(), create: () => refused(401, 'signin_required') });
  await page.flush();
  assert.equal(formShown(page), true);
  await page.submit();
  const post = page.requests.find((r) => r.method === 'POST');
  assert.equal(post.url, '/api/rooms');
  assert.equal(post.body.topic, 'the thing');
  assert.equal(formShown(page), false);
  assert.ok(promptShown(page));
  assert.ok(page.signinHtml().includes("The room wasn't opened because you're not signed in."));
  assert.equal(page.focused, 'signin-link');
  assert.equal(page.errorHtml(), '', 'not also a banner under the hidden form');
});

test('a 401 without the code, and a 401 with another code, are not "sign in": the banner shows the status sentence', async () => {
  for (const res of [refused(401), refused(401, 'other')]) {
    const page = loadStart({ config: ON, me: ME(), create: () => res });
    await page.flush();
    await page.submit();
    assert.equal(formShown(page), true);
    assert.equal(page.signinHtml(), '');
    assert.ok(page.errorHtml().includes(RoomView.errorMessage('create', 401)));
    assert.equal(page.focused, null);
  }
});

test('403: without a code and with a passcode asked for it is the passcode field; with a code (the wrong origin) it is a banner, and the passcode is left alone', async () => {
  const withPass = { live: true, passcode: true, signin: 'github' };
  const plain = loadStart({ config: withPass, me: ME(), create: () => refused(403) });
  await plain.flush();
  plain.el('pass').value = 'x';
  await plain.submit();
  assert.deepStrictEqual(plain.fieldErrors.filter(([id, m]) => id === 'pass' && m), [['pass', "That passcode didn't work. Check it and try again."]]);
  assert.equal(plain.focused, 'pass');
  assert.equal(plain.errorHtml(), '');

  const origin = loadStart({ config: withPass, me: ME(), create: () => refused(403, 'origin') });
  await origin.flush();
  origin.el('pass').value = 'x';
  await origin.submit();
  assert.deepStrictEqual(origin.fieldErrors.filter(([id, m]) => id === 'pass' && m), []);
  assert.ok(origin.errorHtml().includes('Please reload the page and try again.'));
  assert.notEqual(origin.focused, 'pass');
});

test('each coded create refusal shows its own sentence in the banner, never the server text', async () => {
  for (const [status, code] of [[429, 'user_limit'], [429, 'daily_limit'], [503, 'saving_unavailable'], [415, 'content_type']]) {
    const page = loadStart({ config: ON, me: ME(), create: () => refused(status, code) });
    await page.flush();
    await page.submit();
    assert.ok(page.errorHtml().includes(RoomView.errorMessage('create', status, code)), code);
    assert.ok(!page.errorHtml().includes('text from the server'), code);
    assert.equal(formShown(page), true);
  }
});
