'use strict';
// Static files: content hashes, ?v= stamps, ETags, gzip. lib/http.js only routes to it.
// createStaticFiles(publicDir, { now, recheckMs }) returns { get(file), size() }; serveFile writes the response for a file.
//
// Every served file has a hash of the bytes that are sent (the first 12 hex of their SHA-256). It is the ETag, and the `?v=`
// that HTML and CSS put on the local asset URLs they point to, so an asset whose request carries its current hash can be
// cached for a year while the page that names it stays `no-cache`. HTML and CSS are rewritten before they are hashed, so a CSS
// file's hash covers the font hashes inside it, and the HTML that links the CSS stamps that hash: a changed font changes the
// CSS URL changes the page. An entry is kept per file with the source files that went into it (itself and every asset it
// stamped, transitively). It is checked against them (a stat each) at most once per `recheckMs`; a change inside that window
// shows after it. The check keys on mtime and size: an in-place edit that keeps both is served stale until restart.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// One row per file extension: the content type, whether HTML and CSS stamp URLs that end in it, whether it is gzipped.
const TYPES = {
  '.html': { type: 'text/html; charset=utf-8', stamp: false, gzip: true },
  '.js': { type: 'text/javascript', stamp: true, gzip: true },
  '.css': { type: 'text/css', stamp: true, gzip: true },
  '.json': { type: 'application/json', stamp: false, gzip: true },
  '.md': { type: 'text/markdown; charset=utf-8', stamp: false, gzip: true },
  '.svg': { type: 'image/svg+xml', stamp: true, gzip: true },
  '.woff2': { type: 'font/woff2', stamp: true, gzip: false },
  '.png': { type: 'image/png', stamp: true, gzip: false },
  '.ico': { type: 'image/x-icon', stamp: true, gzip: false },
  '.webmanifest': { type: 'application/manifest+json', stamp: true, gzip: true },
  '.txt': { type: 'text/plain; charset=utf-8', stamp: false, gzip: false },
};
const IMMUTABLE = 'private, max-age=31536000, immutable'; // private: a cache that ignores the query string can't serve a stale one

const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

// The file under `publicDir` that a request path names, or null for anything that is not inside it. Pure. The path is
// the raw one (a URL's pathname never has dot segments, but this must hold without that). A colon is refused for
// Windows drive letters and alternate data streams, a backslash and a leading "//" for UNC and mixed-separator tricks.
function resolveStatic(publicDir, pathname) {
  if (/[:\\]/.test(pathname) || pathname.startsWith('//')) return null;
  const f = path.join(publicDir, pathname === '/' ? 'index.html' : path.normalize('.' + pathname));
  return f === publicDir || f.startsWith(publicDir + path.sep) ? f : null;
}

// Whether the request's Accept-Encoding allows gzip (a "gzip;q=0" does not).
function acceptsGzip(header) {
  return String(header || '').split(',').some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name.trim() !== 'gzip') return false;
    const q = params.map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p)).find(Boolean);
    return !q || Number(q[1]) > 0;
  });
}

// The ETag of content with this hash: one per coding, since the bytes differ.
const etagOf = (hash, gzipped) => '"' + hash + (gzipped ? '-gz' : '') + '"';

// Whether an If-None-Match header names this hash (weak comparison, as for a GET). Given `gzipped`, only the ETag of
// that coding counts, so a 304 never vouches for the other coding's bytes; without it, either coding does.
function etagMatches(header, hash, gzipped) {
  const wanted = typeof gzipped === 'boolean' ? [etagOf(hash, gzipped)] : [etagOf(hash, false), etagOf(hash, true)];
  return String(header || '').split(',').some((t) => {
    t = t.trim().replace(/^W\//, '');
    return t === '*' || wanted.includes(t);
  });
}

// "mtime:size" of a file, or "missing" for anything that is not one.
function signature(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.mtimeMs + ':' + st.size : 'missing';
  } catch { return 'missing'; }
}

function createStaticFiles(publicDir, { now = Date.now, recheckMs = 1000 } = {}) {
  // absolute path -> { sources: Map(path -> signature), checkedAt, body, hash, gz }
  const cache = new Map();
  // Case and alias spellings of a file (a case-insensitive disk, a symlink) are not served, so they can't each grow the cache.
  const base = path.dirname(publicDir); // web/ and spec/ both sit under it
  let realBase = null;
  const canonical = (file) => {
    try {
      if (realBase === null) realBase = fs.realpathSync.native(base);
      return fs.realpathSync.native(file) === path.join(realBase, path.relative(base, file));
    } catch { return false; }
  };

  // The served entry of `file`, or null for anything that is not a servable file. `visiting` breaks reference cycles: a
  // reference back to a file still being rewritten is left unstamped, and an entry built that way depends on where the walk
  // started, so it is not kept. `ctx` is one request's: its clock reading and the answers already found.
  function entry(file, ctx, visiting = new Set()) {
    if (ctx.memo.has(file)) return ctx.memo.get(file);
    const found = lookup(file, ctx, visiting);
    if (found && !found.tainted) ctx.memo.set(file, found);
    return found;
  }

  function lookup(file, ctx, visiting) {
    const hit = cache.get(file);
    if (hit) {
      if (ctx.t - hit.checkedAt < recheckMs && ctx.t >= hit.checkedAt) return hit;
      if ([...hit.sources].every(([f, sig]) => signature(f) === sig) && canonical(file)) { hit.checkedAt = ctx.t; return hit; }
      cache.delete(file);
    }
    // The signature is taken before the read: a write that lands during the read then fails the next recheck instead of
    // pinning the old bytes under the new mtime.
    const sig = signature(file);
    if (sig === 'missing' || !canonical(file)) return null;
    let raw;
    try { raw = fs.readFileSync(file); } catch { return null; }
    const sources = new Map([[file, sig]]);
    let tainted = false;
    const stamp = (url) => {
      if (!(TYPES[path.extname(url)] || {}).stamp) return null;
      const target = resolveStatic(publicDir, url);
      if (!target) return null;
      if (visiting.has(target) || target === file) { tainted = true; return null; }
      const dep = entry(target, ctx, new Set(visiting).add(file));
      if (!dep) { sources.set(target, signature(target)); return null; } // a missing target: notice when it appears
      // dep.sources already holds the target's own signature, taken before its read
      for (const [f, sig] of dep.sources) sources.set(f, sig);
      return url + '?v=' + dep.hash;
    };
    const ext = path.extname(file);
    let body = raw;
    if (ext === '.html') {
      // Only inside link, script, img and source tags, so text that shows markup (escaped) is never touched.
      body = Buffer.from(raw.toString('utf8').replace(/<(?:link|script|img|source)\b[^>]*>/g, (tag) =>
        tag.replace(/(\s(?:src|href)=)(["'])(\/(?!\/)[^"'?#]*)\2/g, (m, head, q, url) => { const s = stamp(url); return s ? head + q + s + q : m; })));
    } else if (ext === '.css') {
      body = Buffer.from(raw.toString('utf8').replace(/url\((['"]?)(\/(?!\/)[^'")?#]*)\1\)/g, (m, q, url) => { const s = stamp(url); return s ? 'url(' + q + s + q + ')' : m; }));
    }
    const made = { sources, checkedAt: ctx.t, body, hash: hashOf(body), gz: null, tainted };
    if (!tainted) cache.set(file, made);
    return made;
  }

  return {
    get: (file) => entry(file, { t: now(), memo: new Map() }),
    size: () => cache.size,
  };
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  res.end('Not found');
}

// `v` is the request's ?v=: an asset that names its current hash is immutable.
function serveFile(res, req, file, files, v) {
  const e = files.get(file);
  if (!e) return notFound(res);
  const ext = path.extname(file);
  const kind = TYPES[ext];
  const gzipped = !!(kind && kind.gzip) && acceptsGzip(req.headers['accept-encoding']);
  const headers = { 'cache-control': ext !== '.html' && v === e.hash ? IMMUTABLE : 'no-cache', etag: etagOf(e.hash, gzipped), vary: 'accept-encoding' };
  if (etagMatches(req.headers['if-none-match'], e.hash, gzipped)) {
    res.writeHead(304, headers);
    return res.end();
  }
  let body = e.body;
  if (gzipped) {
    body = e.gz || (e.gz = zlib.gzipSync(e.body));
    headers['content-encoding'] = 'gzip';
  }
  res.writeHead(200, { 'content-type': kind ? kind.type : 'application/octet-stream', 'content-length': body.length, ...headers });
  res.end(body);
}

module.exports = { createStaticFiles, serveFile, resolveStatic, acceptsGzip, etagMatches, TYPES };
