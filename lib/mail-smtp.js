'use strict';
// The SMTP mail transport, and the only file that loads nodemailer (lazily, when MAIL_TRANSPORT=smtp builds it).
// TLS is required either way: secure=true is TLS from the first byte (port 465); secure=false must upgrade with STARTTLS before
// anything else (requireTLS), so the credentials never cross a plain connection, and a server that offers no STARTTLS is refused.
// The certificate is checked (nodemailer's default, never turned off here) and TLS below 1.2 is refused. The pool keeps a few
// connections open and every phase has its own timeout. nodemailer may not read files or fetch URLs for a message, and it logs
// nothing: lib/mail.js logs, with codes only.
// createSmtpTransport({ host, port, secure, user, pass, nodemailer }) -> { kind: 'smtp', verify, send, close }. nodemailer is
// for tests.
const OPTIONS = Object.freeze({
  pool: true,
  maxConnections: 2,
  maxMessages: 100,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 30000,
  dnsTimeout: 10000,
  disableFileAccess: true,
  disableUrlAccess: true,
  logger: false,
  debug: false,
});

function smtpOptions({ host, port, secure, user, pass }) {
  return {
    ...OPTIONS,
    host, port, secure,
    requireTLS: !secure,
    auth: { user, pass },
    tls: { minVersion: 'TLSv1.2' },
  };
}

function createSmtpTransport({ nodemailer, ...settings }) {
  const lib = nodemailer || require('nodemailer');
  const transporter = lib.createTransport(smtpOptions(settings));
  return {
    kind: 'smtp',
    verify: () => transporter.verify(),
    send: (message) => transporter.sendMail(message),
    close: () => transporter.close(),
  };
}

module.exports = { createSmtpTransport, smtpOptions };
