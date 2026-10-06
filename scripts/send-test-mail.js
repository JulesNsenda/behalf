'use strict';
// Sends one test email through the configured transport, to check the mail settings before invites rely on them. Usage:
//   MAIL_TRANSPORT=smtp SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... MAIL_FROM='Behalf <invites@your-domain>' \
//     node scripts/send-test-mail.js you@example.com
// It reads the same variables as the server, checks them the same way (BAD_<NAME>), verifies the connection, sends, and prints
// one line: `sent <message id>` (exit 0) or `failed <code>` (exit 1). It never prints the credentials, the server's reply or the
// message. With MAIL_TRANSPORT=dev (the default) the email lands in the outbox folder instead.
const { loadConfig, consumeSecrets, checkMail, ConfigError } = require('../lib/config');
const { createMailer } = require('../lib/mail');
const { createLog } = require('../lib/log');

async function main(argv) {
  const to = argv[2];
  if (!to || argv.length > 3) {
    console.error('Usage: node scripts/send-test-mail.js <address>');
    return 2;
  }
  let config; let secrets;
  try {
    config = loadConfig();
    secrets = consumeSecrets();
    checkMail(config, secrets);
  } catch (e) {
    if (e instanceof ConfigError) { console.error(`failed ${e.code}`); return 1; }
    throw e;
  }
  const mailer = createMailer({ config, secrets, log: createLog() });
  try {
    await mailer.start();
    if (mailer.status() !== 'ready') { console.error('failed MAIL_UNAVAILABLE (see mail.verify_failed above for the code)'); return 1; }
    const sentAt = new Date().toISOString();
    const out = await mailer.sendMail({
      to,
      subject: 'Behalf test email',
      text: `This is a test email from Behalf, sent at ${sentAt} through the ${mailer.kind} transport.\n\nIf it reached your inbox (not spam), invites will too.\n`,
      html: `<p>This is a test email from Behalf, sent at ${sentAt} through the ${mailer.kind} transport.</p><p>If it reached your inbox (not spam), invites will too.</p>`,
      tag: 'test',
    });
    if (out.status === 'sent') { console.log(`sent ${out.messageId || ''}`.trim()); return 0; }
    console.error(`failed ${out.code}${out.permanent ? ' (permanent)' : ''}`);
    return 1;
  } finally {
    mailer.close();
  }
}

if (require.main === module) main(process.argv).then((code) => process.exit(code), () => { console.error('failed EMAIL'); process.exit(1); });

module.exports = { main };
