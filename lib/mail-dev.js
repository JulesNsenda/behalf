'use strict';
// The dev mail transport: each message becomes <id>.json (the envelope and the plain text) and <id>.html (the HTML body, or the
// plain text escaped in a <pre> when there is none) in an outbox folder. Files are 0600, the folder 0700, and only the newest
// KEEP messages are kept. The outbox holds working links, so its page (/dev/outbox, lib/http.js) is served only off the platform.
// createDevTransport({ dir, now }) -> { kind: 'dev', verify, send, close, outbox: { list(), read(id) } }.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { escapeHtml } = require('./mail');

const KEEP = 500;
const LIST_MAX = 200;
const ID = /^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}$/; // 20261006T101500123Z-1a2b3c4d: sorts by time, and is the only name read back

function createDevTransport({ dir, now = () => Date.now() }) {
  const ensureDir = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  function newId() {
    const stamp = new Date(now()).toISOString().replace(/[-:.]/g, ''); // 20261006T101500123Z
    return `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
  }

  function prune() {
    const ids = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((id) => ID.test(id)).sort();
    for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) {
      for (const ext of ['.json', '.html']) { try { fs.unlinkSync(path.join(dir, id + ext)); } catch { /* already gone */ } }
    }
  }

  async function send(m) {
    ensureDir();
    const id = newId();
    const record = {
      id, at: new Date(now()).toISOString(), from: m.from, to: m.to, replyTo: m.replyTo || null, subject: m.subject, text: m.text, html: Boolean(m.html),
    };
    const html = m.html || `<!doctype html><meta charset="utf-8"><pre style="white-space:pre-wrap;font:15px/1.5 system-ui,sans-serif">${escapeHtml(m.text)}</pre>`;
    // The html first: a listed message (its .json) always has its body.
    fs.writeFileSync(path.join(dir, id + '.html'), html, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
    try { prune(); } catch { /* best effort */ }
    return { messageId: `<${id}@outbox.behalf>`, accepted: [m.to.address], rejected: [] };
  }

  // Newest first, at most LIST_MAX, without the bodies.
  function list() {
    let files;
    try { files = fs.readdirSync(dir); } catch { return []; }
    const ids = files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((id) => ID.test(id)).sort().reverse().slice(0, LIST_MAX);
    const out = [];
    for (const id of ids) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
        out.push({ id, at: r.at, to: r.to, from: r.from, replyTo: r.replyTo, subject: r.subject });
      } catch { /* a half-written or foreign file is skipped */ }
    }
    return out;
  }

  // { record, html } for an id the outbox wrote, else null. The id is checked against ID before it touches a path.
  function read(id) {
    if (typeof id !== 'string' || !ID.test(id)) return null;
    try {
      return { record: JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')), html: fs.readFileSync(path.join(dir, id + '.html'), 'utf8') };
    } catch { return null; }
  }

  return { kind: 'dev', verify: async () => {}, send, close() {}, outbox: { list, read } };
}

module.exports = { createDevTransport, ID };
