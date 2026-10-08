'use strict';
// The real account.js and admin.js, run against a small fake of the admin page and a scripted server: what an admin, a non-admin and a
// signed-out visitor see, how a hostile note and login are shown, and the requests a decision makes. (Static pins are in pages.test.js.)
const { test } = require('node:test');
const assert = require('node:assert');
const { loadPage, ok, refused, ME } = require('../test-support/fake-page');

const T0 = Date.UTC(2026, 9, 3, 12);
const req = (over) => ({ userId: '1001', login: 'octocat', status: 'requested', note: 'I run a small shop.', requestedAt: T0, decidedAt: null, ...over });
const ADMIN = ME({ ai: 'granted', admin: true });

// A server that keeps the list and applies a decision the way the real one does.
function scripted({ me, requests, listAnswer }) {
  const s = { me, requests, log: [], replies: {}, listAnswer };
  const STATUS = { grant: 'granted', deny: 'denied' };
  s.request = (method, url, body) => {
    const route = method + ' ' + url;
    s.log.push(route);
    if (url === '/api/me') return ok(200, JSON.parse(JSON.stringify(s.me)));
    if (s.replies[route] && s.replies[route].length) return s.replies[route].shift();
    if (route === 'GET /api/admin/ai-access') return s.listAnswer ? s.listAnswer() : ok(200, { requests: JSON.parse(JSON.stringify(s.requests)) });
    if (route === 'POST /api/admin/ai-access') {
      s.requests = s.requests.map((r) => (r.userId === body.userId ? { ...r, status: STATUS[body.decision] || 'none', decidedAt: T0 } : r))
        .filter((r) => !(r.userId === body.userId && body.decision === 'reset'));
      return ok(204);
    }
    return refused(404);
  };
  return s;
}

async function open(opts) {
  const server = scripted(opts);
  const page = loadPage({ request: server.request, scripts: ['account.js', 'admin.js'], pathname: '/admin', ...opts.page });
  await page.flush();
  return { server, page };
}

const posts = (server) => server.log.filter((l) => l.startsWith('POST /api/admin'));

test('an admin sees the requests: login, status, when, the note apart, and the decisions that make sense', async () => {
  const { page, server } = await open({ me: ADMIN, requests: [req(), req({ userId: '1002', login: 'second', status: 'granted', note: null, decidedAt: T0 })] });
  const h = page.adminHtml();
  assert.ok(h.includes('<strong>@octocat</strong>') && h.includes('<strong>@second</strong>'));
  assert.ok(h.includes('<span class="pill pill--warn">Waiting</span>') && h.includes('<span class="pill pill--ok">Granted</span>'));
  assert.ok(h.includes('Asked 3 Oct 2026'));
  for (const id of ['grant-1001', 'deny-1001', 'deny-1002', 'reset-1002']) assert.ok(page.byId(id), id);
  for (const id of ['deny-1001x', 'grant-1002', 'reset-1001']) assert.ok(!h.includes('id="' + id + '"'), 'no ' + id);
  assert.ok(h.includes('aria-label="Grant @octocat"'));
  assert.equal(page.el('admin-view').getAttribute('aria-busy'), null, 'no longer busy');
  assert.deepStrictEqual(server.log.filter((l) => l.startsWith('GET /api/admin')), ['GET /api/admin/ai-access']);
  assert.equal(page.focused, null, 'nothing grabs the focus on load');
});

test('the note is quoted plain text, labelled as theirs, inside its own block and never inside a button, a link or an attribute', async () => {
  const note = '<img src=x onerror=alert(1)> https://evil.test/x?a=1&b=2 javascript:alert(1) "quoted" \'single\'';
  const { page } = await open({ me: ADMIN, requests: [req({ note })] });
  const h = page.adminHtml().replace(/>\s+</g, '><'); // the page's own line breaks between tags are not the point
  assert.ok(h.includes('<span class="text-caption">Their note</span>'));
  assert.ok(h.includes('<blockquote class="quote"><p class="quote__text prose">&lt;img src=x onerror=alert(1)&gt; https://evil.test/x?a=1&amp;b=2 javascript:alert(1) &quot;quoted&quot; \'single\'</p></blockquote>'), h);
  assert.ok(!h.includes('<img') && !/<a\b/.test(h), 'no element comes from the note, and no link at all');
  assert.ok(!/href=|onerror=alert\(1\)>/.test(h.replace(/&lt;img[^]*?&gt;/, '')), 'the text is escaped');
  // the note sits before the buttons, in a block of its own
  const noteAt = h.indexOf('<blockquote');
  const buttonsAt = h.indexOf('<button');
  assert.ok(noteAt > 0 && noteAt < buttonsAt);
  assert.ok(!/<button[^>]*>[^<]*<blockquote/.test(h) && !/<button[^>]*>[^]*?<\/button>[^]*?evil/.test(h.slice(buttonsAt)), 'not in a button');
});

test('a hostile login is shown as text; an entry whose user id is not digits is not shown, so no id or label can be forged', async () => {
  const { page } = await open({ me: ADMIN, requests: [req({ login: '<b>x</b>"' }), req({ userId: '1" onclick="x', login: 'forged' }), req({ userId: '7', login: 'ok7' })] });
  const h = page.adminHtml();
  assert.ok(h.includes('<strong>@&lt;b&gt;x&lt;/b&gt;&quot;</strong>'), h);
  assert.ok(!h.includes('forged') && !h.includes('onclick'));
  assert.ok(h.includes('id="request-7"') && page.byId('grant-7'));
  assert.ok(h.includes('aria-label="Grant @&lt;b&gt;x&lt;/b&gt;&quot;"'), 'the label is escaped too');
});

test('no requests yet is a plain sentence', async () => {
  const { page } = await open({ me: ADMIN, requests: [] });
  assert.ok(page.adminHtml().includes('No one has asked for access yet.'));
  assert.ok(!page.adminHtml().includes('<ul'));
});

test('a 404 (not an admin, or nobody signed in) is the plain not available state, with no list and nothing about the server answer', async () => {
  const signedIn = await open({ me: ME(), requests: [], listAnswer: () => refused(404) });
  let h = signedIn.page.adminHtml();
  assert.ok(h.includes("This page isn't available.") && h.includes("It isn't available for your account."), h);
  assert.ok(h.includes('href="/"') && h.includes('Go to the home page'));
  assert.ok(!h.includes('<ul') && !h.includes('text from the server'));
  const out = await open({ me: ME({ user: null }), requests: [], listAnswer: () => refused(404) });
  h = out.page.adminHtml();
  assert.ok(h.includes('Sign in with an administrator account to see it.'));
  assert.ok(out.page.slotHtml().includes('href="/auth/github?next=/admin"'), 'the header offers the sign-in, which comes back here');
});

test('with sign-in off the not available state says there is no admin page, not to sign in', async () => {
  const { page } = await open({ me: ME({ signin: 'off', user: null }), requests: [], listAnswer: () => refused(404) });
  const h = page.adminHtml();
  assert.ok(h.includes("This page isn't available.") && h.includes('This server has no admin page.'), h);
  assert.ok(!h.includes('Sign in with an administrator account'));
});

test('a decision answered 404 after the session ended asks the account again, so the page asks for a sign-in', async () => {
  const { page, server } = await open({ me: ADMIN, requests: [req()] });
  assert.ok(!page.adminHtml().includes('Sign in with an administrator account'));
  server.me = ME({ user: null }); // the session ended meanwhile
  server.replies['POST /api/admin/ai-access'] = [refused(404)];
  server.listAnswer = () => refused(404);
  const asks = () => server.log.filter((l) => l === 'GET /api/me').length;
  const before = asks();
  page.byId('grant-1001').click();
  await page.flush();
  assert.equal(asks(), before + 1, 'the account was asked again');
  assert.ok(page.adminHtml().includes('Sign in with an administrator account to see it.'), page.adminHtml());
  assert.ok(!page.adminHtml().includes("isn't available for your account"));
});

test('a list that cannot be loaded (an error, a network failure, a body that is not a list) says so with a way to try again, and that works', async () => {
  for (const answer of [() => refused(500), () => ({ ok: false, status: 0, data: {} }), () => ok(200, { requests: 'x' }), () => ok(200, {})]) {
    let fail = true;
    const { page, server } = await open({ me: ADMIN, requests: [req()], listAnswer: () => (fail ? answer() : ok(200, { requests: [req()] })) });
    assert.ok(page.adminHtml().includes("We couldn't load the requests. Please try again."), page.adminHtml());
    assert.ok(page.adminHtml().includes('role="alert"'));
    fail = false;
    page.byId('admin-retry').click();
    await page.flush();
    assert.ok(page.byId('grant-1001'), 'the list shows after a retry');
    assert.equal(page.focused, 'admin-list-title');
    assert.equal(server.log.filter((l) => l === 'GET /api/admin/ai-access').length, 2);
  }
});

test('Grant posts the user id and decision as JSON, tells the admin, asks for the list again and moves the focus to the list heading', async () => {
  const { page, server } = await open({ me: ADMIN, requests: [req()] });
  page.byId('grant-1001').click();
  await page.flush();
  assert.deepStrictEqual(page.requests.filter((r) => r.method === 'POST'), [{ method: 'POST', url: '/api/admin/ai-access', body: { userId: '1001', decision: 'grant' } }]);
  assert.deepStrictEqual(page.toasts, [['@octocat can now use our AI.', 'ok']]);
  assert.ok(page.adminHtml().includes('pill--ok">Granted'), 'the list is what the server holds now');
  assert.ok(page.byId('deny-1001') && page.byId('reset-1001') && !page.adminHtml().includes('id="grant-1001"'));
  assert.equal(page.focused, 'admin-list-title');
  assert.equal(server.log.filter((l) => l === 'GET /api/admin/ai-access').length, 2);
});

test('Deny and Reset each post their own decision; a reset request is gone from the list', async () => {
  const a = await open({ me: ADMIN, requests: [req()] });
  a.page.byId('deny-1001').click();
  await a.page.flush();
  assert.equal(a.page.requests.find((r) => r.method === 'POST').body.decision, 'deny');
  assert.deepStrictEqual(a.page.toasts, [['@octocat was denied.', 'ok']]);
  a.page.byId('reset-1001').click();
  await a.page.flush();
  assert.equal(a.page.requests.filter((r) => r.method === 'POST')[1].body.decision, 'reset');
  assert.ok(a.page.adminHtml().includes('No one has asked for access yet.'));
});

test('a refused decision shows its own sentence above the list, which is asked for again', async () => {
  for (const [res, text] of [
    [refused(503, 'saving_unavailable'), 'nothing changed'],
    [refused(403, 'origin'), 'Please reload the page and try again.'],
    [refused(415, 'content_type'), 'Something went wrong sending that.'],
    [refused(400), 'That request no longer matches anyone.'],
    [{ ok: false, status: 0, data: {} }, "couldn't reach the server"],
    [refused(500), "We couldn't save that decision."],
  ]) {
    const { page, server } = await open({ me: ADMIN, requests: [req()] });
    server.replies['POST /api/admin/ai-access'] = [res];
    page.byId('grant-1001').click();
    await page.flush();
    const h = page.adminHtml();
    assert.ok(h.includes('role="alert"') && h.includes(text), text + ' / ' + h);
    assert.ok(!h.includes('text from the server'));
    assert.deepStrictEqual(page.toasts, []);
    assert.ok(page.byId('grant-1001'), 'the request is still listed, as the server has it');
    assert.equal(server.log.filter((l) => l === 'GET /api/admin/ai-access').length, 2);
  }
});

test('a decision refused with 404 (no longer an admin) turns the page into the not available state', async () => {
  const { page, server } = await open({ me: ADMIN, requests: [req()] });
  server.replies['POST /api/admin/ai-access'] = [refused(404)];
  server.listAnswer = () => refused(404);
  page.byId('grant-1001').click();
  await page.flush();
  assert.ok(page.adminHtml().includes("This page isn't available."));
  assert.ok(!page.adminHtml().includes('grant-1001'));
});

test('one decision at a time: a second click while the first is out sends nothing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { page, server } = await open({ me: ADMIN, requests: [req({ userId: '1' }), req({ userId: '2', login: 'two' })] });
  server.replies['POST /api/admin/ai-access'] = [gate.then(() => ok(204))];
  page.byId('grant-1').click();
  page.byId('deny-2').click();
  await page.flush();
  assert.equal(posts(server).length, 1);
  assert.equal(page.byId('grant-1').busy, true, 'the clicked button is busy');
  release();
  await page.flush();
  assert.equal(posts(server).length, 1);
});

test('the header slot of an admin has the Admin link, and signing out comes back to the sign-in link for this page', async () => {
  const { page } = await open({ me: ADMIN, requests: [] });
  assert.equal(page.byId('account-slot').hidden, false);
  assert.ok(page.slotHtml().includes('<a class="btn btn--link" id="account-admin" href="/admin">Admin</a>'), page.slotHtml());
  assert.ok(page.slotHtml().indexOf('id="account-admin"') < page.slotHtml().indexOf('id="sign-out"'), 'the link comes before Sign out');
});
