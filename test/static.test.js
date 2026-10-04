'use strict';
// lib/static.js on its own: the header parsers, the extension table, quote styles, the freshness throttle, reference cycles and
// file names that are not the file's own. (Through the server, with real pages, it is in http.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStaticFiles, acceptsGzip, etagMatches, resolveStatic, TYPES } = require('../lib/static');
const { mkTmp, rmTmp } = require('../test-support/server');

// A temp root with a web/ directory; w(rel, data) writes a file under it.
function tmpWeb(t) {
  const root = mkTmp('static-');
  t.after(() => rmTmp(root));
  const pub = path.join(root, 'web');
  const w = (rel, data) => { fs.mkdirSync(path.dirname(path.join(pub, rel)), { recursive: true }); fs.writeFileSync(path.join(pub, rel), data); };
  const clock = { t: 1e12, now: () => clock.t };
  return { pub, w, clock, files: () => createStaticFiles(pub, { now: clock.now }) };
}

// Counts the file reads made while fn runs.
function countReads(fn) {
  const real = fs.readFileSync;
  let n = 0;
  fs.readFileSync = function (...args) { n += 1; return real.apply(this, args); };
  try { fn(); } finally { fs.readFileSync = real; }
  return n;
}

test('acceptsGzip: gzip by name, case-insensitive, and not with q=0 or when absent', () => {
  assert.equal(acceptsGzip('gzip'), true);
  assert.equal(acceptsGzip('br, GZIP;q=0.8'), true);
  assert.equal(acceptsGzip('deflate, gzip ; q = 1'), true);
  assert.equal(acceptsGzip('gzip;q=0'), false);
  assert.equal(acceptsGzip('gzip;q=0.0'), false);
  assert.equal(acceptsGzip('identity'), false);
  assert.equal(acceptsGzip('xgzip'), false);
  assert.equal(acceptsGzip(''), false);
  assert.equal(acceptsGzip(undefined), false);
});

test('etagMatches: either coding of the same hash, weak forms, lists and *, and nothing else', () => {
  const h = 'abcdef012345';
  for (const header of ['"abcdef012345"', '"abcdef012345-gz"', 'W/"abcdef012345"', 'W/"abcdef012345-gz"', '"x", "abcdef012345-gz"', ' "000000000000" ,W/"abcdef012345" ', '*']) {
    assert.equal(etagMatches(header, h), true, header);
  }
  for (const header of ['"000000000000"', '"abcdef012345-br"', 'abcdef012345', '"abcdef01234"', '', undefined]) {
    assert.equal(etagMatches(header, h), false, String(header));
  }
});

test('etagMatches with a coding: only that coding\'s ETag counts, so a 304 never vouches for the other bytes', () => {
  const h = 'abcdef012345';
  assert.equal(etagMatches('"abcdef012345"', h, false), true);
  assert.equal(etagMatches('W/"abcdef012345-gz"', h, true), true);
  assert.equal(etagMatches('"abcdef012345-gz"', h, false), false);
  assert.equal(etagMatches('"abcdef012345"', h, true), false);
  assert.equal(etagMatches('*', h, true), true);
});

test('the extension table: every stamped or gzipped extension has a content type, and the new types are there', () => {
  for (const [ext, kind] of Object.entries(TYPES)) {
    assert.match(ext, /^\.[a-z0-9]+$/, ext);
    assert.equal(typeof kind.type, 'string', ext);
    assert.ok(kind.type.length > 0, ext);
    assert.equal(typeof kind.stamp, 'boolean', ext);
    assert.equal(typeof kind.gzip, 'boolean', ext);
  }
  assert.equal(TYPES['.png'].type, 'image/png');
  assert.equal(TYPES['.ico'].type, 'image/x-icon');
  assert.equal(TYPES['.webmanifest'].type, 'application/manifest+json');
  assert.equal(TYPES['.html'].stamp, false, 'a page is never stamped into another');
  assert.equal(TYPES['.woff2'].gzip, false, 'fonts are already compressed');
});

test('resolveStatic is exported from lib/static.js as well as lib/http.js', () => {
  assert.equal(require('../lib/http').resolveStatic, resolveStatic);
});


test('HTML stamps single- and double-quoted src and href, and leaves unquoted ones alone', (t) => {
  const { pub, w, files } = tmpWeb(t);
  w('p.html', "<script src='/a.js'></script><script src=\"/a.js\"></script><script src=/a.js></script><link href='/s.css' rel=stylesheet>");
  w('a.js', 'a');
  w('s.css', 'body{}');
  const page = files().get(path.join(pub, 'p.html')).body.toString();
  assert.match(page, /<script src='\/a\.js\?v=[0-9a-f]{12}'><\/script>/);
  assert.match(page, /<script src="\/a\.js\?v=[0-9a-f]{12}"><\/script>/);
  assert.ok(page.includes('<script src=/a.js></script>'), 'unquoted is untouched');
  assert.match(page, /<link href='\/s\.css\?v=[0-9a-f]{12}' rel=stylesheet>/);
});

test('freshness: a changed file is looked at once per recheck window, on the injected clock', (t) => {
  const { pub, w, clock, files } = tmpWeb(t);
  w('a.js', 'one');
  const f = files();
  const file = path.join(pub, 'a.js');
  const first = f.get(file).hash;
  w('a.js', 'two!');
  assert.equal(f.get(file).hash, first, 'inside the window it is not looked at');
  clock.t += 999;
  assert.equal(f.get(file).hash, first, 'still inside');
  clock.t += 2;
  assert.notEqual(f.get(file).hash, first, 'after it, the change shows');
  const reads = countReads(() => { clock.t += 5000; f.get(file); f.get(file); });
  assert.equal(reads, 0, 'an unchanged file is checked, not read again');
});

test('freshness: a stamped asset that changes re-stamps the file that names it, a missing one that appears too', (t) => {
  const { pub, w, clock, files } = tmpWeb(t);
  w('p.html', '<script src="/a.js"></script><script src="/later.js"></script>');
  w('a.js', 'one');
  const f = files();
  const page = path.join(pub, 'p.html');
  const before = f.get(page).body.toString();
  assert.ok(before.includes('/later.js"'), 'a missing asset is left alone');
  w('a.js', 'changed');
  w('later.js', 'new');
  clock.t += 1500;
  const after = f.get(page).body.toString();
  assert.notEqual(after, before);
  assert.match(after, /\/a\.js\?v=[0-9a-f]{12}"/);
  assert.match(after, /\/later\.js\?v=[0-9a-f]{12}"/);
});

test('cycles: two stylesheets that name each other are both served, and the second round is served from the cache', (t) => {
  const { pub, w, clock, files } = tmpWeb(t);
  w('a.css', "@font-face{src:url('/b.css')}\nbody{}");
  w('b.css', "@font-face{src:url('/a.css')}\nhtml{}");
  const f = files();
  const a = path.join(pub, 'a.css');
  const b = path.join(pub, 'b.css');
  const first = [f.get(a), f.get(b)];
  assert.ok(first[0] && first[1]);
  assert.match(first[0].body.toString(), /\/b\.css\?v=[0-9a-f]{12}/);
  assert.match(first[1].body.toString(), /\/a\.css\?v=[0-9a-f]{12}/);
  const hashes = first.map((e) => e.hash);
  const reads = countReads(() => {
    for (let i = 0; i < 3; i++) {
      clock.t += 1500; // past the window each time, so each round checks its files
      assert.deepEqual([f.get(a).hash, f.get(b).hash], hashes, 'the hashes hold: no rebuild ping-pong');
    }
  });
  assert.equal(reads, 0, 'nothing is read again');
  // a file that names itself is served too
  w('self.css', "x{background:url('/self.css')}");
  assert.ok(f.get(path.join(pub, 'self.css')));
});

test('names that are not the file\'s own: a different letter case is never served or cached', (t) => {
  const { pub, w, files } = tmpWeb(t);
  w('ui/ui.css', 'body{}');
  const f = files();
  assert.ok(f.get(path.join(pub, 'ui', 'ui.css')));
  assert.equal(f.size(), 1);
  assert.equal(f.get(path.join(pub, 'UI', 'ui.css')), null);
  assert.equal(f.get(path.join(pub, 'ui', 'UI.CSS')), null);
  assert.equal(f.get(path.join(pub, 'Ui', 'Ui.Css')), null);
  assert.equal(f.size(), 1, 'no second entry, whatever the file system does with the case');
  assert.ok(f.get(path.join(pub, 'ui', 'ui.css')), 'the real name still works');
});

test('names that are not the file\'s own: a symlink to a file is not served', (t) => {
  const { pub, w, files } = tmpWeb(t);
  w('real.js', 'x');
  try { fs.symlinkSync(path.join(pub, 'real.js'), path.join(pub, 'alias.js')); } catch { t.skip('symlinks are not allowed here'); return; }
  const f = files();
  assert.equal(f.get(path.join(pub, 'alias.js')), null);
  assert.ok(f.get(path.join(pub, 'real.js')));
  assert.equal(f.size(), 1);
});
