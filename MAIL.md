# Email

Behalf sends a small number of emails on behalf of a signed-in person: invites, "new questions", "ready to approve", "approved",
one reminder, and sign-in links, plus a short note to the owner when someone asks to use our AI (see **Admin note** below). They go out through **your own SMTP server**. This page covers the settings, the DNS records to
check for the sending domain, and what to do when something goes wrong.

All sending goes through `lib/mail.js` (`sendMail({ to, toName, replyTo, subject, text, html, tag })`). Only `lib/mail-smtp.js`
loads nodemailer.

## Transports

| `MAIL_TRANSPORT` | What happens |
|---|---|
| `dev` (default) | Nothing is sent. Each email is written to the outbox folder (`DROP_DATA_DIR/outbox`, or `./.data/outbox` locally) as `<id>.json` and `<id>.html`, files readable only by the server's user. Off the platform, `/dev/outbox` lists them with links to each email as the recipient would see it. On the platform there is no outbox page, because the emails hold working links. The newest 500 are kept |
| `smtp` | Sent through `SMTP_HOST`. Production uses this once the test email below reaches an inbox |

## Settings

| Env | Required with smtp | Notes |
|---|---|---|
| `MAIL_TRANSPORT` | | `dev` or `smtp` |
| `MAIL_FROM` | yes | `Behalf <invites@your-domain>` or a bare address. Invites show the sender's name in front of it ("Jules via Behalf"), but the address is always this one. Your SMTP server must be allowed to send for its domain |
| `SMTP_HOST` | yes | Host name only, no `smtp://` and no port |
| `SMTP_PORT` | yes | Usually `587` (STARTTLS) or `465` (TLS from the start) |
| `SMTP_SECURE` | no | `true` or `false`; unset follows the port (`465` → `true`, anything else → `false`). `465` with `false` and `587` with `true` are refused at startup |
| `SMTP_USER`, `SMTP_PASS` | yes | Secrets. Set them in the Drop dashboard, never in `drop.yaml`. The server reads them once and removes them from its environment |
| `ADMIN_EMAIL` | no | Where the **Admin note** paragraph below goes. A bare address; dashboard only, never `drop.yaml`. An invalid one stops startup with `BAD_ADMIN_EMAIL` |
| `PUBLIC_URL` | | The base of every link in an email (the deploy's own URL) |

How the connection is made:

- **TLS is always required.** With `SMTP_SECURE=false` the client must upgrade with STARTTLS before it logs in, and it refuses a
  server that doesn't offer it. So the password never crosses a plain connection.
- **Certificates are checked**, and TLS older than 1.2 is refused.
- **Connections are pooled** (at most 2). Connecting, the greeting, each socket read and the DNS lookup each have their own
  timeout (10 to 30 seconds). A whole send attempt gives up after 60 seconds.

A missing or invalid setting stops startup with `BAD_SMTP_HOST`, `BAD_SMTP_PORT`, `BAD_SMTP_AUTH`, `BAD_MAIL_FROM` or
`BAD_SMTP_SECURE` (the code names the variable, never its value).

**At startup the server checks the connection and the login once** (nodemailer's `verify()`). If that fails, the log says
`mail.verify_failed` with a code, sending is turned off until the next restart, and everything else keeps working: the invite
panel says email is unavailable. `/health` shows `mail` (`dev` or `smtp`) and `mailOk`.

**Retries.** A temporary failure (an SMTP `4xx` reply, or a connection that couldn't be made) is retried up to 3 times, after
about 2, 8 and 30 seconds. A permanent failure (an SMTP `5xx` reply, a rejected recipient, a failed login, a TLS error) is not
retried: the send is marked failed and shows in the sender's invite status. Neither is a send that timed out halfway, because
the server may already have accepted it and a retry could deliver it twice.

**Admin note.** With `ADMIN_EMAIL` set, the tag `access_request` is sent once for each new "Use our AI" request (not for a change to the note). The subject is always "Someone asked to use our AI on Behalf"; the body names the requester as a GitHub user and links to `/admin`, and never includes their note. It is capped at 20 an hour and 50 a day; each one says how many requests are waiting now (the new one included); one held back by a cap is not sent. It goes out only where it can be delivered: with `smtp`, or with the dev transport off the platform. On the platform the dev transport doesn't count, and with sign-in off there are no requests, so in both cases boot logs `mail.admin_email_unused`. With `smtp` that has not been verified (yet, or it failed), a notice is skipped and `mail.notice_skipped` is logged once.

**Logs** carry the kind of email (`tag`), the transport and a code (`SMTP_550`, `EAUTH`, `ETLS`, ...). Never an address, a
subject, a body or the server's reply text.

## Send a test email

```sh
MAIL_TRANSPORT=smtp SMTP_HOST=mail.your-domain SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... \
MAIL_FROM='Behalf <invites@your-domain>' node scripts/send-test-mail.js you@example.com
```

It prints `sent <message id>` or `failed <code>`. Try it with addresses at two or three providers (Gmail, Outlook, a company
mailbox) and check that it lands in the **inbox**, not spam. On Drop, run it from a shell with the same variables, or keep
`MAIL_TRANSPORT=dev` until it works from your machine. In Gmail, "Show original" shows whether SPF, DKIM and DMARC passed.

## DNS records for the `MAIL_FROM` domain

Check these for the domain in `MAIL_FROM` (below, `your-domain`). Your mail provider's documentation gives the exact values.

| Record | Where | What to check |
|---|---|---|
| **SPF** | TXT on `your-domain` | One record only, starting `v=spf1`, that includes your SMTP server (e.g. `include:` your provider, or its `ip4:`), ending in `~all` or `-all`. Two SPF records, or more than 10 DNS lookups, make SPF fail |
| **DKIM** | TXT on `<selector>._domainkey.your-domain` | The public key your SMTP server signs with (`v=DKIM1; k=rsa; p=...`). Signing must be turned on at the server for this domain. Use a 2048-bit key |
| **DMARC** | TXT on `_dmarc.your-domain` | Start with `v=DMARC1; p=none; rua=mailto:dmarc@your-domain` to collect reports, then move to `p=quarantine` once SPF and DKIM pass. DMARC passes when SPF or DKIM passes **for the same domain as the From address** (alignment) |
| **Reverse DNS** | PTR on the server's IP | If you run the SMTP server yourself: the IP's PTR name resolves back to the same IP, and the server's HELO name matches it |
| **MX** (optional) | MX on `your-domain` | Not needed to send, but a From domain that can receive bounces looks more trustworthy. Replies go to the sender's own address (Reply-To), not to `MAIL_FROM` |

Quick checks: `dig +short TXT your-domain`, `dig +short TXT <selector>._domainkey.your-domain`, `dig +short TXT _dmarc.your-domain`.

## Troubleshooting

**`mail.verify_failed` with `EAUTH` or `SMTP_535`: the login failed.**
- Check `SMTP_USER` and `SMTP_PASS` in the dashboard. Some providers want the full address as the user name.
- Providers with two-factor sign-in (Google Workspace, Microsoft 365) need an app password or SMTP AUTH turned on for that
  mailbox.
- Make sure the account is allowed to send as the `MAIL_FROM` address.

**`ETLS`, `ESOCKET` or `ECONNECTION` at startup: TLS or connection errors.**
- The port and mode must match: 587 with `SMTP_SECURE=false` (STARTTLS), 465 with `true`. Startup refuses the two usual
  mix-ups.
- If the server offers no STARTTLS on 587, Behalf refuses to log in. That is deliberate. Use 465, or turn STARTTLS on.
- The certificate must be valid for `SMTP_HOST`. Use the name on the certificate, not an IP or an internal alias.
- A firewall may block outbound 25, 465 or 587 from the host. `ESOCKET`/`ECONNECTION` right after start usually means the
  port is closed.

**Sends fail with `SMTP_550`, `SMTP_553` or `SMTP_554`.** The server refused the recipient or the sender. Usually the account
isn't allowed to send as `MAIL_FROM`, or the recipient address doesn't exist. These are not retried.

**Sends fail with `SMTP_421` or `SMTP_451`.** The server is busy or rate-limiting. Behalf retries 3 times. If it keeps
happening, check your provider's sending limits.

**Emails land in spam.**
1. Open the email's headers ("Show original" in Gmail) and check SPF, DKIM and DMARC. All three should say `pass`, and DMARC
   needs alignment (the DKIM `d=` domain or the SPF domain equal to the From domain).
2. Send from a domain (or subdomain, like `mail.your-domain`) with a clean history. A new domain gets less trust for its first
   weeks: start with low volume.
3. Make sure the server's IP isn't on a blocklist (check it on a blocklist lookup site).
4. Keep the content plain: Behalf sends a plain-text part with every email, one link, and no images or tracking.

**Nothing arrives and nothing failed.** With `MAIL_TRANSPORT=dev` nothing is sent: check `/health` (`mail` should be `smtp`).
