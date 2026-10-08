'use strict';
// Email Behalf sends on its own account's behalf rather than a seat's: today a note to the admin about a new "Use our AI" request.
// It builds the message (a fixed subject, text, and HTML through escapeHtml), keeps the caps, and never makes a request wait.
// createNotices({ mailer, deliverable, adminEmail, publicUrl, clock, log }) returns { adminRequest, deliverable }:
//  - adminRequest(user, { pending }): tells adminEmail that `user` ({ login }) asked to use our AI. `pending` is how many requests
//    are waiting now, this one included (lib/ai-access.js counts them); the email says so when it is a positive whole number.
//    Fire-and-forget: it returns nothing, a send that throws or rejects is logged (mail.notice_failed, no fields) and goes no
//    further, and it is never awaited by a request. It sends nothing when adminEmail is unset or deliverable() is false (mail the
//    platform cannot deliver, see lib/app.js); with an address set but no way to deliver, mail.notice_skipped is logged once, and
//    again only after a notice was sent.
//    The requester's note is never in the email: it is untrusted text, and an inbox would turn it into links. The login is
//    re-checked against LOGIN (lib/text.js) and left out if it fails, and is shown as who asked, not as anything vouched for.
//    Caps, in memory: 20 an hour and 50 a day. A notice held back by a cap is simply not sent (the next one that is sent shows the
//    pending count then). mail.notify_capped is logged once when a cap starts holding notices back, and again only after one was sent.
//  - deliverable(): the predicate given, so a route or /api/config can follow the same answer.
// deliverable is asked at each call, because the mailer can turn itself off after boot. No address, subject or text is logged.
const { escapeHtml } = require('./mail');
const { LOGIN } = require('./text');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOURLY_MAX = 20;
const DAILY_MAX = 50;
const SUBJECT = 'Someone asked to use our AI on Behalf';

function createNotices({ mailer, deliverable, adminEmail, publicUrl, clock = {}, log }) {
  const now = clock.now || (() => Date.now());
  const sentAt = []; // when each notice was sent, within the last day, oldest first
  let capLogged = false;
  let skipLogged = false;

  // Whether one more notice may go out now. It counts at once, before the send is awaited.
  function admit() {
    const t = now();
    while (sentAt.length && t - sentAt[0] >= DAY_MS) sentAt.shift();
    const lastHour = sentAt.filter((at) => t - at < HOUR_MS).length;
    if (lastHour >= HOURLY_MAX || sentAt.length >= DAILY_MAX) {
      if (!capLogged) { capLogged = true; log.warn('mail.notify_capped', {}); }
      return false;
    }
    sentAt.push(t);
    capLogged = false;
    return true;
  }

  // The fire-and-forget contract: a send that throws or rejects is logged with no field and goes no further.
  function background(message) {
    try {
      Promise.resolve(mailer.sendMail(message)).catch((e) => log.error('mail.notice_failed', {}, e));
    } catch (e) {
      log.error('mail.notice_failed', {}, e);
    }
  }

  function adminMessage(user, pending) {
    const login = user && typeof user.login === 'string' && LOGIN.test(user.login) ? user.login : null;
    const who = login ? `A GitHub user, @${login},` : 'Someone';
    const adminUrl = `${publicUrl}/admin`;
    const count = Number.isSafeInteger(pending) && pending > 0 ? pending : 0;
    const waitingLine = count === 1 ? 'This is the only request waiting.' : `${count} requests are waiting.`;
    const text = [
      `${who} asked to use our AI on Behalf.`,
      ...(login ? [`https://github.com/${login}`] : []),
      '',
      'Open the admin page to read their note.',
      adminUrl,
      ...(count > 0 ? ['', waitingLine] : []),
    ].join('\n');
    const whoHtml = login ? `A GitHub user, <a href="${escapeHtml(`https://github.com/${login}`)}">@${escapeHtml(login)}</a>,` : 'Someone';
    const html = [
      `<p>${whoHtml} asked to use our AI on Behalf.</p>`,
      `<p>Open the admin page to read their note.</p>`,
      `<p><a href="${escapeHtml(adminUrl)}">${escapeHtml(adminUrl)}</a></p>`,
      ...(count > 0 ? [`<p>${escapeHtml(waitingLine)}</p>`] : []),
    ].join('\n');
    return { to: adminEmail, subject: SUBJECT, text, html, tag: 'access_request' };
  }

  function adminRequest(user, { pending } = {}) {
    try {
      if (!adminEmail) return;
      if (!deliverable()) {
        if (!skipLogged) { skipLogged = true; log.warn('mail.notice_skipped', {}); }
        return;
      }
      if (!admit()) return;
      skipLogged = false;
      background(adminMessage(user, pending));
    } catch (e) {
      log.error('mail.notice_failed', {}, e);
    }
  }

  return { adminRequest, deliverable };
}

module.exports = { createNotices, HOURLY_MAX, DAILY_MAX, SUBJECT };
