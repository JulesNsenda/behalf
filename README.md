# Behalf

Reference implementation of **PXP v0, the Proxy Exchange Protocol**: two AI proxies negotiate for two people, every claim is tagged stated / sourced / assumed, proxies escalate to their humans at a limit, and every agreement ships with a decision brief and a hash-chained ledger.

Based on the essay *Agentic Proxies: When Humans Become Routing Nodes* by Jules Nsenda.

- `spec/` — a copy of the protocol (SPEC.md + JSON schemas). The canonical spec is [JulesNsenda/pxp](https://github.com/JulesNsenda/pxp), published at https://julesnsenda.github.io/pxp/
- `lib/pxp.js` — protocol core: sealing, envelope enforcement, ledger
- `lib/proxy.js` — Claude-backed proxies
- `lib/demo.js` — scripted demo (hallucination cascade), runs with no API key
- `lib/mcp.js` — MCP endpoint at `/mcp`, so any MCP-capable agent can take a seat
- `lib/auth.js`, `lib/http-auth.js` — GitHub sign-in and agent keys
- `lib/mail.js` — email: one `sendMail` over a dev outbox or SMTP (`lib/mail-dev.js`, `lib/mail-smtp.js`). See [MAIL.md](MAIL.md)
- `index.js` — the Node server (Node 20+). Its dependencies are `pg`, loaded only when `DATABASE_URL` is set, and `nodemailer`, loaded only when `MAIL_TRANSPORT=smtp`
- `web/` — the pages:
  - Home (`/`)
  - Start (`/start`): create a room, then invite the other person
  - Room (`/room/:id`): instructions, then the conversation
  - Agreement (`/brief/:id`)
  - Connect (`/connect`): use your own AI agent, and create its agent key
  - Protocol (`/spec`)
- `web/ui/` — the zero-dependency UI library; its living style guide is at `/ui`
- `test/` — `npm test` (node:test). The Postgres tests run only when `PG_TEST_URL` is set

## Config

| Env | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Enables built-in Claude proxies, card drafting and the authority audit. Without it, the demo and bring-your-own-agent rooms still work |
| `PXP_MODEL` | `claude-sonnet-5-5` | Model for proxies |
| `ROOM_PASSCODE` | none | If set, creating a live room requires it. Ten wrong guesses lock an address out for the day, signed in or not |
| `DAILY_ROOM_LIMIT` | 20 | Live rooms per day, all users together |
| `PER_IP_DAILY` | 3 | With `SIGNIN=off`, live rooms per day per address |
| `PER_USER_DAILY` | 3 | With `SIGNIN=github`, live rooms per day per account. A signed-in person is limited by this and `DAILY_ROOM_LIMIT` only, not by their address |
| `MAX_TURNS` | 10 | Proxy turns before a room stalls |
| `PUBLIC_URL` | `https://behalf.dropkit.sh` | Base URL used in seat links handed to agents. With sign-in on, it must be `https` (plain `http` only for `localhost`): its origin is what the browser's `Origin` header must match, and it forms the GitHub callback URL |
| `PORT` | 3000 | Listen port. `0` picks a free port, and the startup log prints the one it bound |
| `BIND_HOST` | all interfaces | Address to bind, e.g. `127.0.0.1`. It isn't called `HOST`, because some shells set `HOST` to the machine name |
| `ROOM_TTL_DAYS` | 30 | A live room is deleted after this many days without activity. Its links then show the room as gone |
| `DEMO_TTL_HOURS` | 24 | The same, for demo rooms |
| `MAX_ROOMS` | 5000 | Upper bound on stored rooms. When a new room would go past it, the server makes room down to 95%: demo rooms go first, oldest first, then finished live rooms. A live room still in progress is never deleted |
| `TRUST_PROXY` | `private` | When to trust `X-Forwarded-For` for the client IP. Choices: `never`; `loopback` (only when the peer is this machine, which is the safest choice when the proxy runs on the same host); `private` (a loopback or private-network peer, such as the platform's proxy); or `always`. `private` assumes no untrusted host on that network can reach the app port directly. Per-IP limits group IPv6 clients by /64. The server logs `net.xff_ignored` once if a forwarded header arrives from an untrusted peer: that is a spoof attempt, or a proxy outside the trusted set |
| `SIGNIN` | `off` locally | `github` or `off`. **Required** whenever `DROP_DATA_DIR` or `DATABASE_URL` is set: without it the server refuses to start (`BAD_SIGNIN`). With `off` there is no sign-in, and anyone (or anyone with the passcode, if one is set) can open live rooms. With `github`, opening a live room needs a GitHub account |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | none | Secrets of your GitHub OAuth app. Both are required when `SIGNIN=github` (`BAD_SIGNIN_SECRETS` otherwise). The server reads them once and removes them from its environment |
| `GITHUB_BLOCKED_IDS` | none | Comma-separated numeric GitHub user ids that may not sign in. Their existing sessions and agent keys stop working at once |
| `REQUIRE_DATABASE` | `0`, or `1` when `DROP_DATA_DIR` is set | `1` or `0`. With `1` the server exits at startup (`BAD_REQUIRE_DATABASE`, before it binds the port) when `DATABASE_URL` is not set, instead of falling back to an empty `rooms.json`. It is on by default on Drop, so the guard holds even if no setting reaches the app; `0` turns it off on purpose |
| `DATABASE_URL` | none | A Postgres URL. When set, rooms and accounts live in Postgres instead of `rooms.json`. Configure the connection only through this URL: don't set the other `PG*` variables. It must be a direct or session-mode connection, not a transaction pooler (`EPOOLER`). The server logs `store.no_tls` if a non-local URL doesn't ask for TLS, or turns off certificate checks |
| `MAIL_TRANSPORT` | `dev` | `dev` or `smtp`. `dev` sends nothing: each email is written to `DROP_DATA_DIR/outbox` (or `./.data/outbox`), and, off the platform only, listed at `/dev/outbox`. `smtp` sends through your SMTP server. See [MAIL.md](MAIL.md) |
| `MAIL_FROM` | none | The sender, `Name <address>` or a bare address, e.g. `Behalf <invites@your-domain>`. Required with `smtp`. Your SMTP server must be allowed to send for its domain |
| `SMTP_HOST`, `SMTP_PORT` | none | Your SMTP server. Required with `smtp` |
| `SMTP_SECURE` | follows the port | `true` (TLS from the start, port 465) or `false` (STARTTLS, port 587). TLS is required either way: the password never crosses a plain connection. `465` with `false` and `587` with `true` are refused (`BAD_SMTP_SECURE`) |
| `SMTP_USER`, `SMTP_PASS` | none | Secrets: the SMTP login. Required with `smtp` (`BAD_SMTP_AUTH`). Read once and removed from the environment |
| `DRAIN_DEADLINE_MS` | 4000 | On `SIGTERM` or `SIGINT`, how long the server may spend saving before it exits. 100 to 9000. Keep it below the time your platform allows between the stop signal and a forced kill (Drop: 5 s under PM2, 10 s under Docker). The Postgres statement timeout is 3 s, so one write fits |

`ROOM_TTL_DAYS`, `DEMO_TTL_HOURS`, `MAX_ROOMS`, `TRUST_PROXY`, `SIGNIN`, `PER_USER_DAILY`, `GITHUB_BLOCKED_IDS`, `DRAIN_DEADLINE_MS`, `REQUIRE_DATABASE` and the mail variables are strict: an invalid value stops the server at startup with `BAD_<NAME>`, and the log names the variable but never its value. `ROOM_TTL_DAYS`, `DEMO_TTL_HOURS` and `MAX_ROOMS` must be whole numbers from 1 up to 3650, 87600 and 1,000,000; `PER_USER_DAILY` from 1 to 1000. Each room also has an AI allowance of `MAX_TURNS × 3` Claude calls, and drafting a card doesn't count toward it. A room that uses it up ends with no deal, like reaching the turn limit.

### Startup refusals

The server stops at startup, and logs one line with a code, rather than run in a state that could lose data. If it stops, look for `store.load_failed` or `app.init_failed` in the log:

| Code | Meaning |
|---|---|
| `BAD_SIGNIN` | `SIGNIN` is missing on the platform, or isn't `github` or `off` |
| `BAD_SIGNIN_SECRETS` | `SIGNIN=github` without both GitHub secrets |
| `BAD_PUBLIC_URL` | `SIGNIN=github` with a `PUBLIC_URL` that isn't https (or http on localhost) |
| `BAD_SMTP_HOST`, `BAD_SMTP_PORT`, `BAD_SMTP_AUTH`, `BAD_MAIL_FROM`, `BAD_SMTP_SECURE` | `MAIL_TRANSPORT=smtp` with a setting missing or invalid, or a port and TLS mode that don't go together. A server that can't be reached or refuses the login does not stop startup: the log says `mail.verify_failed` and sending is off |
| `EFUTURESCHEMA` | The stored data was written by a newer build |
| `ELOCKED` | Another server still holds the database after 45 seconds of retrying. A dead one is released by the database within about 25 seconds; a hung one must be stopped |
| `EPOOLER` | `DATABASE_URL` points at a transaction-mode pooler |
| `ETABLEOWNER` | The database role doesn't own the `behalf_records` table |
| `EIMPORT` | The one-time import of `rooms.json` couldn't read or use the file |
| `PG_<SQLSTATE>` | The database refused the connection or a statement for a reason that retrying won't fix, for example `PG_28P01` (wrong password) or `PG_3D000` (no such database) |
| `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `ECONNRESET`, `PG_57P03` and similar | The database couldn't be reached. The server retried for 45 seconds first |
| `EALLSKIPPED` | Every stored room has an unusable shape. The data is left as it is |
| `EIO`, `ETOOLARGE` | The file store couldn't read or create its data (`EIO` is any read failure; the operating system's own code, such as `EACCES`, can appear instead), or `rooms.json` is too large to read |
| `EQUARANTINE`, `EPRESERVE` | The file store couldn't set an unparseable `rooms.json` aside, or couldn't keep a copy before skipping some rooms |
| `ESHAPE` | The stored metadata or document has an unusable shape |

This covers the common cases, not every code. A `StoreError` is logged as `store.load_failed` with its code, and any other failure to start (including the config codes above) as `app.init_failed`. Both exit with status 1 before the server listens.

## Agents and agent keys

An AI agent joins through MCP at `/mcp`. The seat link is its credential for everything in a room. With `SIGNIN=github`, creating a room also needs the person's **agent key**: sign in on `/connect`, create a key there, and give it to the agent as a header. `/key` is the short link to that panel (it redirects to `/connect#agent-keys`, and answers 404 with sign-in off), and the agent's refusal and instructions name it as `<PUBLIC_URL>/key`. For Claude Code:

```sh
claude mcp add --transport http behalf https://behalf.dropkit.sh/mcp --header "Authorization: Bearer YOUR_AGENT_KEY"
```

A person can hold up to 10 keys at once, one for each app or device. Each is named when it is created ("Which app is this for?", optional, up to 40 characters, and not the same as the name of another key of yours), is shown once, and is deleted on its own on `/connect`; creating a new key ends no other, so to change an app's key you create a new one, then delete the old one. The list shows each key's name (or "Agent key (created <date>, <first 4 characters of the kid>)" when it has none, so two made on one day differ), when it was made and when it was last used. A key has a public id, the `kid`: the first 12 hex characters of the SHA-256 of `kid:` plus its stored id. The `kid` is worked out whenever it is needed and is never stored, and the delete button names a key by it. A key stops working after 90 days unused, or when you delete it, and a key that has been idle that long no longer counts towards the 10. A browser session lasts 7 days without a visit, and 30 days at most.

The page uses `POST /api/me/agent-key` (`{ "name": "..." }`, optional; 201 with the key and its `kid`, 409 `key_limit` at 10 keys, 400 for a name that cannot be kept) and `POST /api/me/agent-key/revoke` (`{ "kid": "..." }`; 204, or 503 while saving is failing, and a retried delete answers 503 again until it is saved). `GET /api/me` lists the keys as `agentKeys`, newest first, with no secret in them.

## Data

**Without `DATABASE_URL`**, state persists to `DROP_DATA_DIR/rooms.json` (or `./.data/rooms.json`). Next to it the server can leave two kinds of recovery copies, and both can hold room content. If the file can't be parsed at all, it is moved aside as `rooms.json.corrupt-<time>` (the newest 5 are kept). If only some rooms fail to load, their original bytes are saved to `rooms.json.partial-<time>`, and those copies are never deleted, because each may be the only remaining copy of a room. Deleting a room from the server (eviction) doesn't delete these copies. Review them, and delete them yourself when they're no longer needed. Delete `rooms.json` to start empty.

**With `DATABASE_URL`**, everything lives in one table, `behalf_records`. Drop it to start empty.
- **First start on Postgres.** If the table is empty and `DROP_DATA_DIR/rooms.json` exists, the server copies every room and the day's usage into the table in one transaction, then renames the file to `rooms.json.imported-<time>`. Account records (users, sessions and agent keys) are imported too, along with the day's usage. Without `DROP_DATA_DIR`, the file it looks for is the local `./.data/rooms.json`. A crash midway leaves the table empty, and the next start imports again. If the table already has data, the file is left alone and the server logs `store.import_skipped`. The `.imported` file keeps room content, seat tokens and any rooms that failed to load: check the import, then delete it once the deploy has soaked and rolling back is ruled out (see Rolling back). An imported key keeps working, and shows as "Agent key (created <date>, <kid start>)" until its owner deletes it.
- **Only one server at a time.** The first server holds the database, and a second one waits and then stops with `ELOCKED`.
- **Losing the database is fatal.** If the connection drops, the server logs `store.lock_lost`; if a statement gets no answer at all, `store.connection_lost`. Either way it exits, and the platform restarts it from the database. Anyone mid-conversation then sees their room paused and presses Resume, and connected agents waiting on `wait_for_turn` get a dropped connection and must call again. If the database is down at startup, the server retries for about 45 seconds before it gives up.

**On `SIGTERM`** the server stops taking work, saves what is pending within `DRAIN_DEADLINE_MS`, and exits 0 (1 if the save failed). **`SIGINT` drains the same way but always exits 130**, whatever the save result. Docker stops an app with `SIGTERM`, but Drop's PM2 mode uses `SIGINT` (PM2's default), so under PM2 the exit code never says whether the last save worked. A failed final save is in the log instead: `store.write_failed` (Postgres) or `store.save_failed` (file store), and `app.drain_timeout` if the save hung. `/health` reports `store` (`file` or `postgres`) and `storeOk`.

**Rolling back.** A newer build can upgrade the stored format. An older build refuses data written by a newer schema and won't start, so keep a copy before an upgrade. An older build that predates sign-in loads a file with accounts but **drops all accounts, sessions and agent keys** on its next save, so after a rollback everyone signs in again and makes a new agent key. An older build that has accounts but predates named keys keeps **only the newest key per user** (it drops the rest when it loads them), and its connect page makes a new key replace the old one; the names are not read, and the other keys are gone after the next save. To go back from Postgres to the file store:

1. Stop the app, so nothing writes while you export.
2. Export the table: `DATABASE_URL=... node scripts/export-rooms.js /path/to/rooms.json`. It needs `pg` (`npm ci`), only reads, doesn't need the database lock, prints counts only, and refuses to overwrite a file. The result is a `rooms.json` in the file store's own format, with every room, the day's usage and the account records.
3. Put that file in `DROP_DATA_DIR` as `rooms.json`. Move any `rooms.json` already there aside first.
4. If the build you deploy defaults `REQUIRE_DATABASE` to `1` on Drop, set `REQUIRE_DATABASE=0` in the dashboard, or it refuses to start without the database. Remove it when you go back to Postgres.
5. Deploy the old build.

`rooms.json.imported-<time>` is only the data as it was at the first Postgres start: rooms created since are only in the database, which is why you export. After restoring a `.partial` or `.corrupt` copy, clear sessions and agent keys, so nobody keeps access that was taken away.

## Deploying on Drop

During a redeploy the new instance answers 503 "starting" until the old one stops and releases the database. Drop starts the new instance while the old one still serves, and stops the old one only once the new one answers HTTP. `index.js` therefore binds the port at once with a placeholder (503, `{"code":"starting"}`, and `{"ok":false,"starting":true}` on `/health`), then swaps in the real server when the store has loaded.

`drop.yaml` asks Drop for a Postgres database (it sets `DATABASE_URL`), sets `SIGNIN: github` and `PUBLIC_URL`, and declares the two GitHub secrets as required. Drop checks declared secrets before it starts the app: if one is missing, it holds the app in `needs-config` instead of letting it crash on start. `DATABASE_URL` is deliberately not declared: Drop sets it itself, and its redeploy check counts only secrets set by hand, so declaring it blocks every redeploy. Check `/health` after a deploy instead (step 5). `REQUIRE_DATABASE` is on by default whenever `DROP_DATA_DIR` is set, and `drop.yaml` sets it to `"1"` as well. Don't set it to `0` in the dashboard (dashboard values override `drop.yaml`) except to run on the file store on purpose, as in *Rolling back*. When Drop starts the app without `DATABASE_URL`, the process exits at once (`BAD_REQUIRE_DATABASE`), the readiness probe fails and the old version keeps serving, instead of an empty file store taking over.

1. Create a GitHub OAuth app. Its callback URL must be exactly `https://behalf.dropkit.sh/auth/github/callback` (`PUBLIC_URL` + `/auth/github/callback`).
2. In the Drop dashboard, set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `ROOM_PASSCODE` and any limits. Also set `TRUST_PROXY` for how Drop connects to the app. Under PM2 isolation, Drop's Caddy reaches the app over loopback (`localhost:PORT`), so set `TRUST_PROXY=loopback`. Under Docker isolation the port is published on the host's loopback, but the app sees the connection from the Docker bridge, a private address: keep the default `private`. (`loopback` under Docker would ignore `X-Forwarded-For`, and every visitor would share one address for the per-address limits.)
3. Any dashboard value overrides `drop.yaml`. Check `SIGNIN` and `PUBLIC_URL` in the dashboard before you redeploy: remove them, or set them to the `drop.yaml` values (`github` and `https://behalf.dropkit.sh`). A leftover `SIGNIN=off` keeps sign-in off, and a stale `PUBLIC_URL` breaks the GitHub callback.
4. Redeploy. On first start the server imports `rooms.json` (see Data). Keep `rooms.json.imported-<time>` until the deploy has soaked and rolling back is ruled out, then delete it: it holds room content and seat tokens.
5. Check `/health`: `store` must be `postgres` and `storeOk` `true`. `store: file` means the database wasn't provisioned: look for `store.file_fallback` in the log. Also check that `/api/config` shows `signin` as `github`.
