'use strict';
// Minimal SSE client for the tests. Collects every `data:` event; comments and blank blocks are skipped.
const http = require('node:http');

// Returns at once with { events: [{json, text}], next(i), drain(), close() }; the request is made in the background.
// next(i) resolves with the i-th event (0-based) as soon as it exists, and rejects if the connection fails or 5s pass.
// drain() resolves once no new event has arrived for quietMs (bounded by maxMs), so a test can look at all of a broadcast.
function openSse(base, url) {
  const events = [];
  const waiters = [];
  let buf = '';
  let closed = false;
  const req = http.get(base + url);
  const check = () => {
    for (const w of waiters.slice()) if (events.length > w.i) { waiters.splice(waiters.indexOf(w), 1); w.resolve(events[w.i]); }
  };
  req.on('response', (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let end;
      while ((end = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        events.push({ json: JSON.parse(line.slice(6)), text: line });
      }
      check();
    });
  });
  req.on('error', (e) => { if (!closed) for (const w of waiters) w.reject(e); });
  const close = () => { closed = true; req.destroy(); };
  const next = (i) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no SSE event #' + i + ' within 5s')), 5000);
    t.unref();
    waiters.push({ i, resolve: (v) => { clearTimeout(t); resolve(v); }, reject });
    check();
  });
  const drain = async ({ quietMs = 150, maxMs = 3000 } = {}) => {
    const end = Date.now() + maxMs;
    for (;;) {
      const n = events.length;
      await new Promise((r) => setTimeout(r, quietMs));
      if (events.length === n || Date.now() >= end) return events;
    }
  };
  return { events, next, drain, close };
}

// The first event only, then the connection is dropped.
async function firstSseEvent(base, url) {
  const s = openSse(base, url);
  try { return await s.next(0); } finally { s.close(); }
}

module.exports = { openSse, firstSseEvent };
