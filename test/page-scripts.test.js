'use strict';
// The real account.js and connect.js, run against a fake of the page and a scripted server: what the agent key panel, the header slot and
// the command show after each kind of answer, where the focus goes, and which requests were made. (Static pins live in pages.test.js.)
const { test } = require('node:test');
const assert = require('node:assert');
const { loadPage, loadRoomKit, makeEl, ok, refused, ME } = require('../test-support/fake-page');

const KEY = 'bh_' + 'k'.repeat(43);

// A button on the page, for the room-kit act() tests.
const ctl = (id, over) => Object.assign(makeEl({ focused: null }, id), { localName: 'button', isConnected: true }, over);

// A server that keeps who is signed in and whether they have a key, and answers the page's requests the way the real one does.
function scripted(initial) {
  const s = { me: initial, meFails: false, replies: {}, log: [] };
  s.request = (method, url, body) => {
    s.log.push(method + ' ' + url);
    if (url === '/api/me') return s.meFails ? refused(500) : ok(200, JSON.parse(JSON.stringify(s.me)));
    const route = method + ' ' + url;
    if (s.replies[route] && s.replies[route].length) return s.replies[route].shift();
    if (route === 'POST /api/me/agent-key') { s.me.agentKey = { createdAt: 5 }; return ok(201, { key: KEY, createdAt: 5 }); }
    if (route === 'POST /api/me/agent-key/revoke') { s.me.agentKey = null; return ok(204); }
    if (route === 'POST /auth/logout') { s.me = { signin: 'github', user: null, agentKey: null }; return ok(204); }
    return refused(404);
  };
  return s;
}

async function open(initial, over) {
  const server = scripted(initial);
  const page = loadPage({ request: server.request, ...over });
  await page.flush();
  return { server, page };
}

const hasKeyField = (page) => page.panelHtml().includes('id="agent-key"');
const withKey = async (t) => {
  const h = await open(ME());
  h.page.byId('key-create').click();
  await h.page.flush();
  assert.ok(hasKeyField(h.page), 'precondition: the new key is on screen');
  return h;
};

test('signed in with no key: the panel offers to create one, and the command has no header', async () => {
  const { page } = await open(ME());
  assert.equal(page.byId('key-panel').hidden, false);
  assert.ok(page.byId('key-create'));
  assert.equal(page.byId('key-revoke'), null);
  assert.equal(page.command(), 'claude mcp add --transport http behalf https://behalf.test/mcp');
  assert.equal(page.byId('no-signin-note').hidden, true, '"There is no sign-in." is for sign-in off');
  assert.equal(page.focused, null, 'nothing grabs the focus on load');
});

test('creating a key: the key is shown once as a value (with autocomplete off) and in the command, the focus goes to it, and the request is a JSON POST', async () => {
  const { page } = await open(ME());
  page.byId('key-create').click();
  await page.flush();
  const post = page.requests.find((r) => r.method === 'POST');
  assert.deepStrictEqual(post, { method: 'POST', url: '/api/me/agent-key', body: {} }, 'bodyless POSTs would be refused with a 415: the call passes {}');
  assert.ok(hasKeyField(page));
  assert.equal(page.byId('agent-key').value, KEY);
  assert.equal(page.byId('agent-key').getAttribute('autocomplete'), 'off');
  assert.ok(!page.panelHtml().includes(KEY), 'the key is never in the markup');
  assert.equal(page.command(), 'claude mcp add --transport http behalf https://behalf.test/mcp --header "Authorization: Bearer ' + KEY + '"');
  assert.equal(page.focused, 'agent-key');
  assert.ok(page.byId('key-revoke'));
});

test('other re-renders never move the focus to the key field', async () => {
  const { page, server } = await open(ME());
  page.byId('key-create').click();
  await page.flush();
  page.focused = null;
  page.window.Account.refresh(); // for example the header's sign-out refreshing the page
  await page.flush();
  assert.ok(hasKeyField(page), 'still shown');
  assert.equal(page.focused, null);
  assert.ok(server.log.length > 0);
});

test('deleting the key: the key goes from the page, the command loses its header, a toast says so, and focus lands on the create button', async () => {
  const { page } = await withKey();
  page.byId('key-revoke').click();
  await page.flush();
  const post = page.requests.filter((r) => r.method === 'POST').pop();
  assert.deepStrictEqual(post, { method: 'POST', url: '/api/me/agent-key/revoke', body: {} });
  assert.ok(!hasKeyField(page));
  assert.equal(page.command(), 'claude mcp add --transport http behalf https://behalf.test/mcp');
  assert.deepStrictEqual(page.toasts, [['Your agent key no longer works.', 'ok']]);
  assert.equal(page.focused, 'key-create');
  assert.ok(page.byId('key-create') && !page.byId('key-revoke'));
});

test('a refused create clears the key that was on screen, asks the server again, and says why; focus stays in the panel', async () => {
  const { page, server } = await withKey();
  const asked = server.log.filter((l) => l === 'GET /api/me').length;
  server.replies['POST /api/me/agent-key'] = [refused(503, 'saving_unavailable')];
  server.me.agentKey = null; // what the server really did: the old key went out first
  page.byId('key-create').click();
  await page.flush();
  assert.ok(!hasKeyField(page), 'the shown key is gone');
  assert.ok(!page.command().includes(KEY) && !page.command().includes('--header'));
  assert.ok(server.log.filter((l) => l === 'GET /api/me').length > asked, 'the page asked the server what is true');
  assert.ok(page.panelHtml().includes('you have no working agent key right now'));
  assert.ok(!page.panelHtml().includes('text from the server'));
  assert.equal(page.focused, 'key-create');
});

test('a refused delete keeps the panel honest: it asks again, shows the key as the server has it, and says why', async () => {
  const { page, server } = await open(ME({ agentKey: { createdAt: 5 } }));
  assert.ok(page.panelHtml().includes('You created an agent key on'));
  server.replies['POST /api/me/agent-key/revoke'] = [refused(503, 'saving_unavailable')];
  const asked = server.log.filter((l) => l === 'GET /api/me').length;
  page.byId('key-revoke').click();
  await page.flush();
  assert.ok(server.log.filter((l) => l === 'GET /api/me').length > asked);
  assert.ok(page.panelHtml().includes('your agent key may still work'));
  assert.deepStrictEqual(page.toasts, []);
  assert.equal(page.focused, 'key-create');
});

test('a 401 means the session is gone: the page asks, shows the sign-in link with the sentence, and the focus goes to that link', async () => {
  const { page, server } = await withKey();
  server.me = ME({ user: null });
  server.replies['POST /api/me/agent-key'] = [refused(401, 'signin_required')];
  page.byId('key-create').click();
  await page.flush();
  assert.ok(!hasKeyField(page));
  assert.ok(page.byId('key-signin'));
  assert.ok(page.panelHtml().includes('Your sign-in has ended.'));
  assert.equal(page.focused, 'key-signin');
  assert.equal(page.command(), 'claude mcp add --transport http behalf https://behalf.test/mcp');
});

test('no answer at all (the network): the page stays as it was, the key still on screen, and nothing is asked again', async () => {
  const { page, server } = await withKey();
  const asked = server.log.filter((l) => l === 'GET /api/me').length;
  server.replies['POST /api/me/agent-key/revoke'] = [{ ok: false, status: 0, data: {} }];
  page.byId('key-revoke').click();
  await page.flush();
  assert.ok(hasKeyField(page), 'a delete that did not get through has not changed what the page knows');
  assert.equal(server.log.filter((l) => l === 'GET /api/me').length, asked);
  assert.ok(page.panelHtml().includes("We couldn't reach the server."));
});

test('a 201 whose key is not a key is a failure: nothing is shown, and the page asks again', async () => {
  for (const bad of [{}, { key: '' }, { key: 'bh_short' }, { key: 'sk-' + 'x'.repeat(40) }, { key: KEY + ' ' }, { key: 7 }]) {
    const { page, server } = await open(ME());
    server.replies['POST /api/me/agent-key'] = [ok(201, bad)];
    page.byId('key-create').click();
    await page.flush();
    assert.ok(!hasKeyField(page), JSON.stringify(bad));
    assert.ok(page.panelHtml().includes("We couldn't create your agent key."), JSON.stringify(bad));
    assert.ok(!page.command().includes('--header') || page.command().includes('YOUR_AGENT_KEY'));
  }
});

test('a refresh that fails after a good answer leaves the key and the panel as they were', async () => {
  const { page, server } = await withKey();
  server.meFails = true;
  const before = page.panelHtml();
  page.window.Account.refresh();
  await page.flush();
  assert.equal(page.panelHtml(), before);
  assert.equal(page.window.Account.load !== undefined, true);
  // and a create whose follow-up read fails still shows the key it was handed
  const h = await open(ME());
  h.server.meFails = true;
  h.page.byId('key-create').click();
  await h.page.flush();
  assert.ok(hasKeyField(h.page), 'the key was handed to the page and nothing says otherwise');
  assert.equal(h.page.byId('agent-key').value, KEY);
});

test('the key does not outlive the page: pagehide empties it, and coming back from the back-forward cache asks the server and drops it', async () => {
  const { page, server } = await withKey();
  page.fire('pagehide');
  assert.ok(!hasKeyField(page), 'the field is gone');
  assert.ok(!page.command().includes(KEY));
  assert.ok(!page.panelHtml().includes('Your new key is below'), 'and so is the sentence about it');
  const { page: p2 } = await withKey();
  const asked = p2.meRequests();
  p2.fire('pageshow', { persisted: false });
  await p2.flush();
  assert.ok(hasKeyField(p2), 'an ordinary show changes nothing');
  p2.fire('pageshow', { persisted: true });
  await p2.flush();
  assert.ok(!hasKeyField(p2), 'a restored page has no key');
  assert.ok(p2.meRequests() > asked);
  assert.ok(server);
});

test('sign-in off: no /api/me request on the pages that fill the header or the panel, no panel and no slot, and the old sentence stays', async () => {
  const server = scripted(ME());
  const page = loadPage({ request: server.request, config: { live: true, passcode: false, signin: 'off' } });
  await page.flush();
  assert.deepStrictEqual(page.requests, []);
  assert.equal(page.byId('account-slot').hidden, true);
  assert.equal(page.byId('key-panel').hidden, true);
  assert.equal(page.byId('no-signin-note').hidden, false);
  assert.equal(page.command(), 'claude mcp add --transport http behalf https://behalf.test/mcp');
  // the same on a page with only the header
  const home = loadPage({ request: server.request, scripts: ['account.js'], pathname: '/', config: { live: true, passcode: false, signin: 'off' } });
  await home.flush();
  assert.deepStrictEqual(home.requests, []);
});

test('signed out with sign-in on: the header holds a sign-in link back to this page, the panel a link too, and "no sign-in" is hidden', async () => {
  const { page } = await open(ME({ user: null }));
  assert.ok(page.slotHtml().includes('href="/auth/github?next=/connect"'));
  assert.ok(page.slotHtml().includes('id="account-signin"'));
  assert.ok(page.byId('key-signin'));
  assert.equal(page.byId('no-signin-note').hidden, true);
  assert.equal(page.byId('account-slot').hidden, false);
});

test('signing out from the header: a JSON POST, the slot and the panel follow, and the focus goes to the sign-in link', async () => {
  const { page, server } = await withKey();
  assert.ok(page.slotText().includes('Signed in as octocat'));
  page.byId('sign-out').click();
  await page.flush();
  const post = page.requests.filter((r) => r.url === '/auth/logout');
  assert.deepStrictEqual(post, [{ method: 'POST', url: '/auth/logout', body: {} }]);
  assert.ok(page.slotHtml().includes('id="account-signin"'));
  assert.ok(!hasKeyField(page), 'the key goes with the session');
  assert.ok(page.byId('key-signin'));
  assert.equal(page.focused, 'account-signin');
  assert.deepStrictEqual(page.toasts, [["You're signed out.", 'ok']]);
  assert.ok(server);
});

test('a sign-out that could not be saved still shows signed out, with the sentence that says what is true', async () => {
  const { page, server } = await open(ME());
  server.replies['POST /auth/logout'] = [refused(503, 'saving_unavailable')];
  const original = server.request;
  page.byId('sign-out').click();
  server.me = ME({ user: null }); // the cookie is cleared whatever the saving did
  await page.flush();
  assert.ok(page.slotHtml().includes('id="account-signin"'));
  assert.equal(page.toasts.length, 1);
  assert.match(page.toasts[0][0], /^You're signed out\. It may take a moment to be recorded\.$/);
  assert.ok(original);
});

// ---------- the header slot alone (home and the protocol page load account.js and nothing else of this) ----------
const headerOnly = (pathname, initial, over) => {
  const server = scripted(initial);
  const page = loadPage({ request: server.request, scripts: ['account.js'], pathname, ...over });
  return { server, page };
};

test('header slot on home and the protocol page: signed out is a sign-in link that comes back to home, but not to the protocol page', async () => {
  const home = headerOnly('/', ME({ user: null }));
  await home.page.flush();
  assert.ok(home.page.slotHtml().includes('href="/auth/github?next=/"'));
  assert.equal(home.page.byId('account-slot').hidden, false);
  const spec = headerOnly('/spec', ME({ user: null }));
  await spec.page.flush();
  assert.ok(spec.page.slotHtml().includes('href="/auth/github"'), 'the server does not return to /spec');
  assert.ok(!spec.page.slotHtml().includes('next='));
});

test('header slot, signed out: a small secondary button with the GitHub mark and both labels (the CSS shows one), never a primary', async () => {
  const { page } = headerOnly('/', ME({ user: null }));
  await page.flush();
  const h = page.slotHtml();
  assert.ok(h.startsWith('<a class="btn btn--secondary btn--small" id="account-signin" href="/auth/github?next=/">'), h);
  assert.ok(h.includes('<svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">'), 'the GitHub mark, hidden from readers');
  assert.ok(h.includes('<span class="site-header__account-long">Sign in with GitHub</span>'));
  assert.ok(h.includes('<span class="site-header__account-short">Sign in</span>'));
  assert.ok(!h.includes('btn--primary'));
});

test('header slot, signed in: the login and a Sign out button, with "Signed in as" read out but not shown, and a login-less user shown as "Signed in"', async () => {
  const { page } = headerOnly('/', ME());
  await page.flush();
  assert.equal(page.slotHtml(), '<span class="site-header__account-who"><span class="sr-only">Signed in as </span><span class="site-header__account-login">octocat</span></span><button class="btn btn--link" type="button" id="sign-out">Sign out</button>');
  const bare = headerOnly('/', ME({ user: { login: '' } }));
  await bare.page.flush();
  assert.equal(bare.page.slotHtml(), '<span class="site-header__account-who"><span class="site-header__account-login">Signed in</span></span><button class="btn btn--link" type="button" id="sign-out">Sign out</button>');
});

test('header slot on home and the protocol page: signed in shows who and Sign out, and no key panel is touched', async () => {
  for (const p of ['/', '/spec']) {
    const { page } = headerOnly(p, ME());
    await page.flush();
    assert.ok(page.slotText().includes('Signed in as octocat'), p);
    assert.ok(page.slotHtml().includes('id="sign-out"'), p);
    assert.equal(page.byId('key-panel').hidden, true, p);
    assert.deepStrictEqual(page.requests.map((r) => r.url), ['/api/me'], p);
  }
});

test('header slot: an /api/me that cannot be read leaves the slot hidden and empty, and a later good answer fills it', async () => {
  const { page, server } = headerOnly('/', ME());
  server.meFails = true;
  await page.flush();
  assert.equal(page.byId('account-slot').hidden, true);
  assert.equal(page.slotHtml(), '');
  server.meFails = false;
  await page.window.Account.refresh();
  assert.ok(page.slotText().includes('Signed in as octocat'));
  assert.equal(page.byId('account-slot').hidden, false);
});

test('header slot with the settings unreadable: it still asks /api/me, so a signed-in person sees who they are', async () => {
  const { page } = headerOnly('/', ME(), { config: null });
  await page.flush();
  assert.ok(page.slotText().includes('Signed in as octocat'));
});

test('header slot: signing out on home toasts, shows the sign-in link back to home and moves focus to it', async () => {
  const { page } = headerOnly('/', ME());
  await page.flush();
  page.byId('sign-out').click();
  await page.flush();
  assert.ok(page.slotHtml().includes('href="/auth/github?next=/"'));
  assert.equal(page.focused, 'account-signin');
  assert.deepStrictEqual(page.toasts, [["You're signed out.", 'ok']]);
});

test('header slot: a sign-out that never reached the server says so, and the slot still shows the person signed in', async () => {
  const { page, server } = headerOnly('/', ME());
  await page.flush();
  server.replies['POST /auth/logout'] = [{ ok: false, status: 0, data: {} }];
  page.byId('sign-out').click();
  await page.flush();
  assert.equal(page.toasts.length, 1);
  assert.equal(page.toasts[0][1], 'warn');
  assert.ok(page.slotText().includes('Signed in as octocat'));
  assert.equal(page.focused, 'sign-out', 'focus goes to the control that is still there');
});

test('a second Account.load shares the first request, and the listeners hear every refresh that got an answer and none that did not', async () => {
  const { page, server } = headerOnly('/', ME());
  await page.flush();
  const A = page.window.Account;
  const heard = [];
  A.onChange((me) => heard.push(me.user && me.user.login));
  await A.load(); await A.load();
  assert.equal(page.meRequests(), 1);
  await A.refresh();
  assert.deepStrictEqual(heard, ['octocat']);
  server.meFails = true;
  const kept = await A.refresh();
  assert.equal(kept.user.login, 'octocat', 'the last good answer is kept');
  assert.deepStrictEqual(heard, ['octocat']);
});

test('a key on screen goes when the session ends, and does not come back if somebody is signed in again on the same page', async () => {
  const { page, server } = await withKey();
  server.me = ME({ user: null });
  await page.window.Account.refresh();
  assert.ok(!hasKeyField(page));
  assert.ok(!page.command().includes(KEY));
  server.me = ME({ agentKey: { createdAt: 9 } });
  await page.window.Account.refresh();
  assert.ok(!hasKeyField(page), 'the old key is not shown again');
  assert.ok(!page.command().includes(KEY));
  assert.ok(page.panelHtml().includes('You created an agent key on'));
});

test('a key the server no longer has is dropped when its answer says so: a refused delete while the server has no key leaves no field and no Bearer in the command', async () => {
  const { page, server } = await withKey();
  server.replies['POST /api/me/agent-key/revoke'] = [refused(503, 'saving_unavailable')];
  server.me.agentKey = null; // the server dropped it in memory, and could not save
  page.byId('key-revoke').click();
  await page.flush();
  assert.ok(!hasKeyField(page));
  assert.ok(!page.command().includes('Bearer bh_') && !page.command().includes(KEY));
  assert.ok(!page.panelHtml().includes('Your new key is below'));
});

test('a key that is not the server\'s current one (another was created since) is dropped on the next answer', async () => {
  const { page, server } = await withKey();
  server.me.agentKey = { createdAt: 99 };
  await page.window.Account.refresh();
  await page.flush();
  assert.ok(!hasKeyField(page));
  assert.ok(page.panelHtml().includes('You created an agent key on'));
});

test('a create whose follow-up read fails still shows the new key once (the render that is its only chance), unreconciled', async () => {
  const { page, server } = await open(ME());
  server.meFails = true;
  page.byId('key-create').click();
  await page.flush();
  assert.ok(hasKeyField(page));
});

test('two refreshes that come back out of order: the older answer never undoes the newer', async () => {
  const waiting = [];
  const server = scripted(ME());
  const page = loadPage({ request: (m, u, b) => (u === '/api/me' && waiting.armed ? new Promise((resolve) => waiting.push(resolve)) : server.request(m, u, b)) });
  await page.flush();
  waiting.armed = true;
  const first = page.window.Account.refresh();
  const second = page.window.Account.refresh();
  await page.flush();
  assert.equal(waiting.length, 2);
  waiting[1](ok(200, ME({ agentKey: { createdAt: 7 } }))); // the newer question answers first
  await page.flush();
  assert.ok(page.panelHtml().includes('You created an agent key on'));
  waiting[0](ok(200, ME())); // the older one, from before the key existed, arrives late
  await Promise.all([first, second]);
  await page.flush();
  assert.ok(page.panelHtml().includes('You created an agent key on'), 'still the newer answer');
  assert.deepStrictEqual((await page.window.Account.load()).agentKey, { createdAt: 7 });
});

test('coming back from the back-forward cache when the refresh fails: no key field and no "Your new key is below" over an empty one', async () => {
  const { page, server } = await withKey();
  server.meFails = true;
  page.fire('pageshow', { persisted: true });
  await page.flush();
  assert.ok(!hasKeyField(page));
  assert.ok(!page.panelHtml().includes('Your new key is below'));
  assert.ok(!page.command().includes(KEY));
});

test('room page: a refused seat action passes its machine code on, so a draft refused while the server stops says so', async () => {
  const kit = loadRoomKit();
  const refuse = async (data) => {
    kit.reset('help-error');
    await kit.A.ui.act({ busy: null, error: 'help-error', kind: 'draft', send: () => Promise.resolve({ ok: false, status: 503, data }) });
    return kit.html('help-error');
  };
  assert.match(await refuse({ error: 'x', code: 'shutting_down' }), /Behalf is restarting\. Try again in a moment\. You can fill in the fields yourself\./);
  assert.match(await refuse({ error: 'x' }), /This server can't write drafts/);
  assert.match(await refuse(undefined), /write drafts/, 'no body at all is no code');
});

test('room page: act() switches off only the enabled `disable` elements while out, and on failure switches back on only those, then refocuses the busy control', async () => {
  const kit = loadRoomKit();
  const busy = ctl('opt-a');
  const other = ctl('opt-b');
  const already = ctl('opt-c', { disabled: true });
  let seen;
  const focused = [];
  busy.focus = () => focused.push('busy');
  const res = kit.A.ui.act({
    busy, disable: [other, already], error: 'e', kind: 'answer',
    send: () => { seen = [other.disabled, already.disabled]; return Promise.resolve({ ok: false, status: 500, data: {} }); },
  });
  await res;
  assert.deepStrictEqual(seen, [true, true], 'off while the request is out');
  assert.equal(other.disabled, false, 'the one act switched off is back on');
  assert.equal(already.disabled, true, 'the one that was already off stays off');
  assert.deepStrictEqual(focused, ['busy']);

  // a single element works, and a busy control that left the page is not focused
  const gone = ctl('opt-d', { isConnected: false });
  const lone = ctl('ta');
  focused.length = 0;
  gone.focus = () => focused.push('gone');
  await kit.A.ui.act({ busy: gone, disable: lone, error: 'e', kind: 'answer', send: () => Promise.resolve({ ok: false, status: 500, data: {} }) });
  assert.equal(lone.disabled, false);
  assert.deepStrictEqual(focused, []);

  // success with no busy element leaves them off
  const keep = ctl('opt-e');
  await kit.A.ui.act({ busy: null, disable: keep, error: 'e', kind: 'answer', send: () => Promise.resolve({ ok: true, status: 200, data: {} }) });
  assert.equal(keep.disabled, true);
});

test('room page: oneShot().enter is true once per new key, only when ready, and records the key either way', () => {
  const shot = loadRoomKit().A.ui.oneShot();
  assert.equal(shot.enter('decision', 'k1', false), false, 'not ready: no motion');
  assert.equal(shot.enter('decision', 'k1', true), false, 'the key was recorded while not ready, so it is not new');
  assert.equal(shot.enter('decision', 'k2', true), true, 'a new key');
  assert.equal(shot.enter('decision', 'k2', true), false, 'the same key again');
  assert.equal(shot.enter('outcome', 'k2', true), true, 'each name keeps its own key');
  assert.equal(shot.enter('outcome', null, false), false, 'nothing there records null');
  assert.equal(shot.enter('outcome', 'k2', true), true, 'the same outcome after it went away is new again');
  shot.reset();
  assert.equal(shot.enter('decision', 'k2', true), true, 'reset starts the keys over');
});

test('room page: act() on failure refocuses only when the focus was lost', async () => {
  const kit = loadRoomKit();
  const fail = { ok: false, status: 500, data: {} };
  const run = async (activeOf) => {
    const busy = ctl('b');
    const off = ctl('o');
    const elsewhere = ctl('x');
    const got = [];
    busy.focus = () => got.push('busy');
    kit.document.activeElement = activeOf({ busy, off, elsewhere, body: kit.document.body });
    await kit.A.ui.act({ busy, disable: off, error: 'e', kind: 'answer', send: () => Promise.resolve(fail) });
    return got;
  };
  assert.deepStrictEqual(await run(({ elsewhere }) => elsewhere), [], 'focus the person moved elsewhere stays');
  assert.deepStrictEqual(await run(() => null), ['busy']);
  assert.deepStrictEqual(await run(({ body }) => body), ['busy']);
  assert.deepStrictEqual(await run(({ busy }) => busy), ['busy']);
  assert.deepStrictEqual(await run(({ off }) => off), ['busy'], 'a switched-off control that had the focus lost it');
});

test('room page: act() on success switches the controls back on only when the step was not redrawn', async () => {
  const kit = loadRoomKit();
  const good = { ok: true, status: 200, data: {} };
  const still = ctl('b1');
  const offA = ctl('o1');
  await kit.A.ui.act({ busy: still, disable: offA, error: 'e', kind: 'answer', send: () => Promise.resolve(good) });
  assert.equal(offA.disabled, false, 'busy control still on the page: switched back on');
  assert.equal(still.getAttribute('aria-busy'), null, 'and the busy control itself is no longer busy');
  assert.equal(still.disabled, false);
  const redrawn = ctl('b2');
  const offB = ctl('o2');
  kit.A.refresh = () => { redrawn.isConnected = false; return Promise.resolve(true); };
  await kit.A.ui.act({ busy: redrawn, disable: offB, error: 'e', kind: 'answer', send: () => Promise.resolve(good) });
  assert.equal(offB.disabled, true, 'busy control gone: the redraw owns them, left alone');
  assert.equal(redrawn.getAttribute('aria-busy'), 'true', 'a busy control that left the page is left alone too');
});

test('a key the server has since lost (deleted elsewhere) is dropped on the next answer', async () => {
  const { page, server } = await withKey();
  server.me.agentKey = null;
  await page.window.Account.refresh();
  await page.flush();
  assert.ok(!hasKeyField(page));
  assert.ok(!page.command().includes('Bearer bh_'));
});

test('a refused delete clears the key on screen even when the server still has that very key: it says what may still work, without the secret', async () => {
  const { page, server } = await withKey();
  server.replies['POST /api/me/agent-key/revoke'] = [refused(503, 'saving_unavailable')]; // the server's key (created at 5) is untouched
  page.byId('key-revoke').click();
  await page.flush();
  assert.ok(!hasKeyField(page));
  assert.ok(page.panelHtml().includes('You created an agent key on'));
  assert.ok(page.panelHtml().includes('your agent key may still work'));
  assert.ok(!page.command().includes(KEY));
});

test('a key on screen goes with the session: after a sign-out, signing in again does not bring it back, even though the account still has that key', async () => {
  const { page, server } = await withKey();
  server.me = ME({ user: null, agentKey: { createdAt: 5 } });
  await page.window.Account.refresh();
  server.me = ME({ agentKey: { createdAt: 5 } }); // the same key record, a new session
  await page.window.Account.refresh();
  await page.flush();
  assert.ok(!hasKeyField(page));
  assert.ok(page.panelHtml().includes('You created an agent key on'));
  assert.ok(!page.command().includes(KEY));
});
