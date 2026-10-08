'use strict';
// Email Behalf sends on its own account's behalf rather than a seat's: a note to the admin about a new "Use our AI" request, and the invite to seat B.
// It builds the message (a fixed subject, text, and HTML through escapeHtml), keeps the caps, and never makes a request wait.
// createNotices({ mailer, deliverable, adminEmail, publicUrl, clock, log }) returns { adminRequest, sendInvite, inviteAllowed, deliverable }:
//  - sendInvite({ to, login, link }) emails the seat B link (tag invite; see inviteMessage), fire-and-forget like adminRequest, and
//    spends one of the address's 3 a day. inviteAllowed(to) asks whether that slot is free. The address is held only as an HMAC under
//    a per-process key and is never logged.
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
const crypto = require('crypto');
const { escapeHtml } = require('./mail');
const { LOGIN } = require('./text');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOURLY_MAX = 20;
const DAILY_MAX = 50;
const SUBJECT = 'Someone asked to use our AI on Behalf';
const INVITE_SUBJECT = "You're invited to work out an agreement on Behalf";
const INVITES_PER_ADDRESS = 3; // a day, to one address, from anyone

function createNotices({ mailer, deliverable, adminEmail, publicUrl, clock = {}, log }) {
  const now = clock.now || (() => Date.now());
  const sentAt = []; // when each notice was sent, within the last day, oldest first
  const invited = new Map(); // HMAC of an address -> when each invite to it was taken, within the last day (in memory only)
  const inviteKey = crypto.randomBytes(32);
  let capLogged = false;
  let skipLogged = false;
  let inviteSkipLogged = false;

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

  // The invite to seat B: a fixed subject and text. No name, topic or any text the sender typed, and no replyTo (the sender's
  // address is not known and a reply would reach Behalf's own mailbox). The login is shown as who sent it, as in adminMessage.
  function inviteMessage(to, login, link) {
    const ok = typeof login === 'string' && LOGIN.test(login) ? login : null;
    const who = ok ? `A GitHub user, @${ok},` : 'Someone';
    const text = [
      `${who} invited you to work out an agreement on Behalf. Your private link: ${link}`,
      '',
      'On Behalf, your AI and theirs work out an agreement for the two of you, and ask you before they go past your limits.',
      '',
      "If you didn't expect this, you can ignore it.",
    ].join('\n');
    const whoHtml = ok ? `A GitHub user, <a href="${escapeHtml(`https://github.com/${ok}`)}">@${escapeHtml(ok)}</a>,` : 'Someone';
    const html = [
      `<p>${whoHtml} invited you to work out an agreement on Behalf.</p>`,
      `<p>Your private link: <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
      '<p>On Behalf, your AI and theirs work out an agreement for the two of you, and ask you before they go past your limits.</p>',
      "<p>If you didn't expect this, you can ignore it.</p>",
    ].join('\n');
    return { to, subject: INVITE_SUBJECT, text, html, tag: 'invite' };
  }

  // Invites to one address, across all senders: INVITES_PER_ADDRESS a day. The key is an HMAC of the normalised address (below) under a
  // key made for this process, so the table holds no address and is lost on restart. Entries older than a day are dropped at every call.
  function prune(t) {
    for (const [k, times] of invited) {
      const live = times.filter((at) => t - at < DAY_MS);
      if (live.length) invited.set(k, live); else invited.delete(k);
    }
  }
  // The usual spellings of one mailbox share an allowance: lowercase; a +tag dropped from the local part; and for Gmail (googlemail.com
  // is the same service) the dots in the local part dropped too. Other providers keep their dots, which can differ there.
  function normaliseAddress(to) {
    const s = String(to).trim().toLowerCase();
    const at = s.lastIndexOf('@');
    if (at < 0) return s;
    let local = s.slice(0, at).replace(/\+.*$/, '');
    let domain = s.slice(at + 1);
    if (domain === 'googlemail.com') domain = 'gmail.com';
    if (domain === 'gmail.com') local = local.replace(/\./g, '');
    return `${local}@${domain}`;
  }
  const addressKey = (to) => crypto.createHmac('sha256', inviteKey).update(normaliseAddress(to)).digest('hex');

  // Whether one more invite to `to` is allowed. Counts nothing: sendInvite counts, in the same synchronous run as this check.
  function inviteAllowed(to) {
    const t = now();
    prune(t);
    return (invited.get(addressKey(to)) || []).length < INVITES_PER_ADDRESS;
  }

  // Fire-and-forget, like adminRequest: returns nothing and never throws. The slot for `to` is spent here, even when nothing is sent
  // (mail went undeliverable meanwhile): nothing is refunded. `link` is the seat B link, from the domain. The route (lib/app.js invite)
  // has checked deliverable() in the same synchronous run, so the !deliverable() branch is unreachable there; it stays as a guard for a
  // direct caller.
  function sendInvite({ to, login, link }) {
    try {
      const k = addressKey(to);
      invited.set(k, [...(invited.get(k) || []), now()]);
      if (!deliverable()) {
        if (!inviteSkipLogged) { inviteSkipLogged = true; log.warn('mail.notice_skipped', {}); }
        return;
      }
      inviteSkipLogged = false;
      background(inviteMessage(to, login, link));
    } catch (e) {
      log.error('mail.notice_failed', {}, e);
    }
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

  return { adminRequest, sendInvite, inviteAllowed, deliverable };
}

module.exports = { createNotices, HOURLY_MAX, DAILY_MAX, SUBJECT, INVITE_SUBJECT, INVITES_PER_ADDRESS };
