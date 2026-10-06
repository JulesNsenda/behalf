'use strict';
// Email: one interface, sendMail({ to, toName, replyTo, subject, text, html, tag, fromName }), over one of two transports chosen
// by MAIL_TRANSPORT. dev (lib/mail-dev.js) writes each message to an outbox folder; smtp (lib/mail-smtp.js, the only file that
// loads nodemailer) sends through the configured SMTP server. Nothing else in the server knows which one is in use.
//
// createMailer({ config, secrets, log, clock, transport }) returns:
//  - start(): checks the transport once (transport.verify(), bounded by VERIFY_MS). A failure is logged (mail.verify_failed) and
//    turns sending off for the life of the process; the rest of the app keeps running. Idempotent.
//  - status(): 'checking' | 'ready' | 'unavailable'. available(): anything but 'unavailable'.
//  - sendMail(msg) -> { status: 'sent' | 'failed', messageId?, attempts, code?, permanent? }. It never throws for a delivery
//    problem, and never for a bad message: that is { status: 'failed', code: 'MAIL_INVALID', permanent: true }. A send waits for
//    a check that is still running. Temporary failures (an SMTP 4xx, a connection that could not be made) are retried up to
//    MAX_RETRIES times with backoff; a permanent one (an SMTP 5xx, a rejected recipient, failed authentication) is not. Neither
//    is a send that timed out locally: the server may have accepted it, and a retry could deliver it twice.
//  - outbox: the dev outbox's { list(), read(id) }, or null with smtp.
//  - close(): closes the transport (its connection pool). Idempotent.
// Logging: an error's message can carry addresses or the server's reply, so only a vetted code is ever logged (as `code`, e.g.
// SMTP_550 or EAUTH), with the message's tag. Never an address, a subject or a body.
const crypto = require('crypto');
const { EMAIL, smtpSecure } = require('./config');

// The kinds of email Behalf sends. A tag is logged, so it is one of these and nothing else.
const TAGS = Object.freeze(['invite', 'questions', 'brief_ready', 'approved', 'reminder', 'signin', 'test']);
const MAX_RETRIES = 3;
const BACKOFF_MS = [2000, 8000, 30000]; // before retry 1, 2 and 3; each with up to 25% jitter
const VERIFY_MS = 20000;
const SEND_MS = 60000; // one attempt, end to end (the transport has its own connection and socket timeouts below this)
const LIMITS = { name: 80, subject: 200, text: 100000, html: 300000 };
// Connection-level codes that mean nothing was accepted, so the send can be tried again.
const TEMP_CODES = new Set(['ECONNECTION', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const CODE = /^E[A-Z0-9_]{1,30}$/;
const defaultClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

// A failure with a fixed message and a vetted code: what the logger sees instead of the transport's own error.
class MailError extends Error {
  constructor(code) { super('Email failed'); this.name = 'MailError'; this.code = code; }
}

const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL.test(s);
// A display name: no control characters (no header can be started from it), whitespace collapsed, capped.
const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name) : '');

// The message as the transport gets it, or null when it is not one Behalf may send.
function normalise(msg, from) {
  if (!msg || typeof msg !== 'object') return null;
  const { to, toName, replyTo, subject, text, html, tag, fromName } = msg;
  if (!isEmail(to) || (replyTo !== undefined && replyTo !== null && !isEmail(replyTo))) return null;
  if (!TAGS.includes(tag)) return null;
  if (typeof subject !== 'string' || /[\r\n]/.test(subject) || !subject.trim() || subject.length > LIMITS.subject) return null;
  if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.text) return null;
  if (html !== undefined && html !== null && (typeof html !== 'string' || html.length > LIMITS.html)) return null;
  const out = {
    from: { name: cleanName(fromName) || from.name || 'Behalf', address: from.address },
    to: { name: cleanName(toName), address: to },
    subject: subject.trim(),
    text,
    tag,
  };
  if (replyTo) out.replyTo = replyTo;
  if (html) out.html = html;
  return out;
}

// What a transport error means: { code, temporary }. An SMTP reply code decides when there is one; otherwise a connection code
// that says nothing was accepted is temporary, and anything else (authentication, TLS, a refused envelope, the unknown) is not.
function classify(e) {
  const reply = e && Number.isInteger(e.responseCode) ? e.responseCode : null;
  if (reply !== null && reply >= 400 && reply < 600) return { code: `SMTP_${reply}`, temporary: reply < 500 };
  const code = e && typeof e.code === 'string' && CODE.test(e.code) ? e.code : 'EMAIL';
  return { code, temporary: TEMP_CODES.has(code) };
}

function withTimeout(promise, ms, code) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new MailError(code)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function buildTransport({ config, secrets }) {
  if (config.mailTransport === 'smtp') {
    return require('./mail-smtp').createSmtpTransport({
      host: config.smtpHost, port: config.smtpPort, secure: smtpSecure(config), user: secrets.smtpUser, pass: secrets.smtpPass,
    });
  }
  const path = require('path');
  return require('./mail-dev').createDevTransport({ dir: path.join(config.dataDir || path.join(require('./config').ROOT, '.data'), 'outbox') });
}

function createMailer({ config, secrets, log, clock = {}, transport } = {}) {
  const sleep = clock.sleep || defaultClock.sleep;
  const t = transport || buildTransport({ config, secrets });
  const from = config.mailFrom || { name: 'Behalf', address: 'invites@localhost' };
  let state = 'checking';
  let checking = null;
  let closed = false;

  function start() {
    if (checking) return checking;
    checking = withTimeout(Promise.resolve().then(() => t.verify()), VERIFY_MS, 'ETIMEDOUT').then(
      () => { if (state === 'checking') state = 'ready'; log.info('mail.ready', { status: t.kind }); },
      (e) => { state = 'unavailable'; log.error('mail.verify_failed', { status: t.kind }, new MailError(classify(e).code)); },
    );
    return checking;
  }

  async function attempt(message) {
    const info = await withTimeout(Promise.resolve().then(() => t.send(message)), SEND_MS, 'MAIL_TIMEOUT');
    const rejected = info && Array.isArray(info.rejected) ? info.rejected : [];
    if (rejected.length) throw Object.assign(new MailError('MAIL_REJECTED'), { permanent: true });
    const id = info && typeof info.messageId === 'string' ? info.messageId.slice(0, 200) : undefined;
    return id;
  }

  async function sendMail(msg) {
    const message = normalise(msg, from);
    if (!message) {
      log.warn('mail.invalid', {});
      return { status: 'failed', code: 'MAIL_INVALID', permanent: true, attempts: 0 };
    }
    const { tag, ...payload } = message;
    if (state === 'checking') await start();
    if (state !== 'ready' || closed) return { status: 'failed', code: 'MAIL_UNAVAILABLE', permanent: false, attempts: 0 };
    for (let n = 1; ; n++) {
      try {
        const messageId = await attempt(payload);
        log.info('mail.sent', { tag, status: t.kind });
        return { status: 'sent', messageId, attempts: n };
      } catch (e) {
        const timedOut = e instanceof MailError && e.code === 'MAIL_TIMEOUT';
        const { code, temporary } = e instanceof MailError ? { code: e.code, temporary: false } : classify(e);
        if (!temporary || timedOut || n > MAX_RETRIES) {
          log.error('mail.failed', { tag, status: t.kind }, new MailError(code));
          return { status: 'failed', code, permanent: !temporary && !timedOut, attempts: n };
        }
        log.warn('mail.retry', { tag, status: t.kind }, new MailError(code));
        const base = BACKOFF_MS[n - 1];
        await sleep(base + Math.floor(Math.random() * base * 0.25));
      }
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    try { if (t.close) t.close(); } catch (e) { log.warn('mail.close_failed', {}, new MailError(classify(e).code)); }
  }

  return {
    kind: t.kind,
    start, sendMail, close,
    status: () => state,
    available: () => state !== 'unavailable',
    outbox: t.outbox || null,
  };
}

// Escapes text for an HTML email body or attribute. Every value a person or an AI wrote goes through this.
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const randomId = () => crypto.randomBytes(8).toString('hex');

module.exports = { createMailer, classify, normalise, escapeHtml, randomId, MailError, TAGS, MAX_RETRIES, BACKOFF_MS };
