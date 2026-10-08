# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Behalf is the reference implementation of **PXP v0 (Proxy Exchange Protocol)**: two AI proxies negotiate for two humans, every claim is tagged `stated` / `sourced` / `assumed`, proxies escalate to their humans at a limit, and an agreement produces a decision brief plus a hash-chained ledger. `spec/SPEC.md` is the normative protocol, and the code implements it.

## Commands

Node 20+ (it uses global `fetch`). There is no build or lint step. The dependencies are `pg` and `nodemailer` (`npm ci` locally; Drop runs `npm install`). `pg` is loaded only when `DATABASE_URL` is set, and `nodemailer` only when `MAIL_TRANSPORT=smtp` (by `lib/mail-smtp.js`, the one file that may require it), so the file store, local dev and most of the suite run without `node_modules`.

```sh
npm test                              # node:test suite in test/ (UI tokens + contrast, ui.js, server, pages)
node index.js                         # or: npm start  (PORT defaults to 3000; PORT=0 picks a free port, BIND_HOST is optional)
DEMO_DELAY_MS=200 node index.js       # speed up the scripted demo (default 2600ms per turn)
curl localhost:3000/health            # {ok, live, rooms, store, storeOk, mail, mailOk, build}; build = hash of the source tree
open localhost:3000/dev/outbox        # emails the dev transport wrote (only off the platform)
node scripts/send-test-mail.js you@example.com   # one test email through the configured transport (MAIL.md)
curl -XPOST localhost:3000/api/demo   # create a scripted demo room, then open /room/<id>?seat=A&t=<token>
# Linux + Node 20, which also runs the POSIX-only tests. The repo is mounted read-only.
docker run --rm -v "$PWD:/app:ro" -w /app node:20 node --test
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/app:ro" -w /app node:20 node --test   # the same, from Git Bash on Windows
# The Postgres tests run only with PG_TEST_URL. Its database name must end in _test: the tests DROP the table.
# PostgreSQL 13+ (the 16 image is what is used). The role needs CREATEDB (the auth and export tests make their own database), and the tests terminate backends, so use a scratch server. From Docker, reach the host as host.docker.internal.
PG_TEST_URL=postgres://behalf:behalf@localhost:55432/behalf_test npm test
```

Without `ANTHROPIC_API_KEY`, the scripted demo and rooms where both seats are "bring your own agent" (MCP) still work. Built-in Claude proxies, card drafting and the authority audit need the key. The other env vars are in the README table. State persists to `$DROP_DATA_DIR/rooms.json`, or `./.data/rooms.json` when that variable isn't set. Delete that file to reset. With `DATABASE_URL`, state lives in the `behalf_records` table: drop it to reset. `SIGNIN` defaults to `off` locally, but must be set when `DROP_DATA_DIR` or `DATABASE_URL` is.

`REQUIRE_DATABASE=1` (strict; default `1` when `DROP_DATA_DIR` is set, else `0`; also set in `drop.yaml`; the spawned test servers default it to `0` in `test-support/server.js` `baseEnv`) makes `index.js` exit 1 with `BAD_REQUIRE_DATABASE` before binding the placeholder when `DATABASE_URL` is missing, so a Drop start without the database fails the readiness probe instead of serving an empty file store.

Deployment: `drop.yaml` targets the Drop platform: `type: nodejs`, health check `/health`, `database: postgres` (Drop sets `DATABASE_URL`), `env:` with `SIGNIN: github` and `PUBLIC_URL`, and the two GitHub secrets declared `required` (Drop holds the app in `needs-config` until they are set). `drop.yaml` `env:` is Drop's base layer: a value set in the dashboard overrides it. The `/health` `build` fingerprint of a Drop deploy won't match a local run: Drop runs `npm install` (the detector's choice, so the resolved `package-lock.json` can differ) and its build changes the app directory. Confirm a deploy by `/health` `store` and `storeOk` (`postgres`, true) and `/api/config` `signin`. The README has the deploy steps, including the rollback export (`scripts/export-rooms.js`).

## Architecture

The backend is a set of small `lib/` modules, each with one job, assembled in one place.

**`lib/app.js`** is the composition root.
- `bootApp(overrides)` is the async entry. It reads the config and the secrets **once**, picks the store with `buildStore` (Postgres when `DATABASE_URL` is set, else the file), awaits its load, then calls `createApp`.
- `createApp(overrides)` is synchronous. It builds the proxy, the domain, sign-in (`lib/auth.js`, only with `SIGNIN=github`) and the HTTP server, and assembles the `ops` object for `lib/mcp.js`.
- `savePolicy` decides what may go on while saving fails: room creation keeps working for 60 seconds (`canCreate`), and revoking a session or key refuses at once (`canRevoke`), so a revocation that can't be saved never looks done.
- `drain()` is how the process leaves: it stops the turn loop and the web layer, settles the store's writes, closes it, and resolves whether everything was saved. It is idempotent.

Every dependency can be overridden (`config`, `secrets`, `log`, `store`, `proxy`, `fetch`, `githubFetch`, `timeouts`, `clock`, `demo`, `http`, …), so tests run the whole app in-process with fakes. Neither function exits the process. A store that can't load throws a `StoreError`.

**`index.js`** is a thin entry point. It does three things:
- binds the port first with a placeholder that answers 503 `starting` (a redeploy's new instance must answer HTTP while the old one holds the database lock; it prints nothing, and is closed before the real server binds the same port). SIGTERM/SIGINT while booting exits at once, 0 / 130;
- calls `bootApp()`. A failure exits 1 after one log line: `store.load_failed` for a `StoreError`, else `app.init_failed` (a `ConfigError` carries `BAD_<NAME>`);
- listens, printing the listen line, which `test-support/server.js` matches, so keep it byte for byte;
- leaves through one exit latch. `SIGTERM` runs `app.drain()` within `DRAIN_DEADLINE_MS` and exits 0, or 1 if it couldn't save. `SIGINT` drains the same way but always exits 130, whatever the save result. That matters because Drop's PM2 mode stops an app with SIGINT (PM2's default kill signal) and Docker with SIGTERM: a failed final save shows only in the log (`store.write_failed` for Postgres, `store.save_failed` for the file store, `app.drain_timeout` if the drain hung), not in the exit code. A lost store (`onFatal`), an unhandled rejection or an uncaught exception logs, drains for at most 2 seconds and exits 1. The first reason to leave wins.

**`lib/config.js`** reads the environment once:
- `loadConfig()` returns a frozen object of plain settings.
- `consumeSecrets()` returns `ROOM_PASSCODE`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, redacted in `JSON.stringify` and `util.inspect`, and deletes them from `process.env`.
- `checkSignin(config, secrets)` checks that `SIGNIN=github` can work: both GitHub secrets (`BAD_SIGNIN_SECRETS`) and an https `PUBLIC_URL`, or http only on localhost (`BAD_PUBLIC_URL`).
- New variables are strict: an invalid value throws `ConfigError` with code `BAD_<NAME>`, and the message never holds the value.

Secrets are never in the config object.

**`lib/log.js`** writes one line per event to stderr. Its rules:
- **Fields:** only allowlisted fields are written: room, seat, status, httpStatus, errorClass, code, durationMs, stack, reason, kind and tag (`reason` takes only `ttl` or `capacity`; `kind` takes only a record kind or `meta`; `tag` only an email kind from `TAGS` in `lib/mail.js`). A new field must be added to `ALLOWED`, and a test pins that list.
- **Messages:** an error's `message` is **never** logged, because it can echo model output or a card. Log errors as `log.error(event, fields, err)`. The logger takes the class, a vetted code and well-formed stack frames from `err`.

**Persistence** is three modules with one public API. The in-memory state is the runtime source of truth, and the domain stays synchronous; a store loads it, then writes behind it.
- **`lib/store-core.js`** is shared by both stores: validation, migrations, serialisation, the record kinds (rooms, `usage`, and the account collections `user`, `session` and `agentkey` from `collection(kind)`), and the write cycle. The write cycle runs one write at a time, never loses a change made during a write, backs off after a failure, reports `health()`, and `drain()`s.
- **`lib/store.js`** is the file store, `rooms.json`. Each room is serialised on its own, so one bad room can't block a save. A write goes to a temp file (mode 0600, `fsync`), then is renamed over `rooms.json`, with retries on Windows. A file that can't be parsed is quarantined as `.corrupt-<ts>` (5 kept); a room with a bad shape, or a bad account record, is kept in a `.partial-<ts>` copy (never pruned). Any other read failure stops startup rather than overwrite the file.
- **`scripts/export-rooms.js`** is the rollback export: it reads `behalf_records` (one read-only transaction, no lock) and writes a `rooms.json` in the file store's own shape, to a new path. It refuses to overwrite a file and never prints the URL or a record.
- **`lib/store-pg.js`** is the Postgres store, one table `behalf_records (kind, id, doc, updated_at)`. One connection holds a session advisory lock and runs every transaction:
  - **Holder wins.** A boot that can't get the lock within 45 seconds stops with `ELOCKED`. The platform runs one instance, stopping the old one before starting the new.
  - **Epoch fence.** Each load writes a fresh epoch into the meta row, and every transaction (writes, the import, the migration) locks that row and refuses to go on if the epoch is not its own (`EEPOCH`).
  - **Timing.** The writer session's `statement_timeout` (`STATEMENT_MS`, 3 s) is below the drain deadline (`DRAIN_DEADLINE_MS`, default 4 s), so a hung final write gives up before the drain does; releasing the connection has its own two 2 s limits. Drop kills the app 5 s after the stop signal under PM2 and 10 s under Docker (`docker stop -t 10`).
  - **Fatal on loss.** If the connection ends, a statement gets no answer within its watchdog, or the epoch changes, the store logs `store.lock_lost` (`store.connection_lost` when a statement got no answer) and calls `onFatal`, and the process exits. Nothing reconnects; the platform restarts it.
  - **Zombies** are reaped by the server: `idle_in_transaction_session_timeout`, plus TCP keepalive settings on the writer session for a dead peer holding the lock outside a transaction. Do not add `idle_session_timeout`: it would kill the legitimate holder.
  - **The one-time import** copies `DROP_DATA_DIR/rooms.json` into an empty table in one transaction, then renames the file `rooms.json.imported-<ts>`. A crash leaves the table empty and the next boot imports again.
  - Boot also refuses a transaction-mode pooler (`EPOOLER`, best-effort) and a table the role doesn't own (`ETABLEOWNER`). Database errors reach the logger as `PG_<SQLSTATE>`; messages, rows and the URL are never logged.
- **Schema versions:** data with a newer `schemaVersion` is refused (`EFUTURESCHEMA`). An older build that predates accounts drops the account collections on its next write.

**`lib/rooms.js`** is the domain. It owns the room lifecycle, the turn loop and the quota, and it never touches HTTP:
- **The turn loop.** `run(room)` drives built-in proxies until one of these happens: agreement, escalation, `maxTurns` (stalled), an error, or a turn owned by an **external** seat. For an external seat it sets `waitingOn` and returns. The external agent then calls in through `externalTurn()`, which re-enters `run()`. `room.running` is the re-entrancy guard.
- **`advance()`** is the single path every proxy turn goes through, whether it comes from built-in Claude, the demo script or an MCP agent. It calls `pxp.buildEnvelope` and `pxp.applyEnvelope`, then handles the escalate, agree or continue transition.
- **Run-to-completion invariant.** Every domain op is synchronous except `externalTurn` and `draftCard`. `draftCard` serves only the web draft route, so it is not in `ops`. Each synchronous op ends by calling `run()` synchronously, so the status has flipped before the caller responds. JavaScript's run-to-completion orders the ops, so there is no queue. The only hazard is state that changes during an `await`, so code after an await re-checks what it saw before it. Example: a draft that finishes after its seat was sealed is discarded.
- **`hydrate()`** applies the restart rules on load:
  - `running` and `thinking` are reset;
  - a built-in turn that a restart cut off becomes `status: 'paused', interrupted: true`;
  - a stored `room.error` is replaced by its fixed client-safe sentence.
- **Client-facing errors.** `room.error` and every error response are fixed sentences. The detail goes to the log.
- **Changes.** `onChange(fn)` is how the HTTP layer hears about room changes.
- **Eviction.** Two kinds:
  - **By age.** At load, then hourly on an unref'd timer. A live room goes after `ROOM_TTL_DAYS` without activity, and a demo room after `DEMO_TTL_HOURS`. "Activity" means the last ledger `at`, falling back to `createdAt`. A live room waiting on an external agent counts as idle.
  - **By capacity.** When creating a room would go past `MAX_ROOMS`, rooms are evicted down to 95% of it, oldest first within each tier. The tiers, in order: untouched demos, finished demos, any other demo (a running one stops), live rooms that are agreed or stalled, and finally live rooms in error with their AI allowance spent.

  A room that `busy()` reports as in use (a turn running, or a draft in flight) is never evicted, and an unfinished live room is never evicted for capacity. Afterwards the room page and the agreement page show the room as gone: their API calls, the SSE stream and the MCP tools return 404 or "Room not found". The eviction log line carries `reason` (`ttl` or `capacity`).
- **AI allowance.** Each room gets an AI allowance of `maxTurns × 3` Claude calls. Turns and the authority audit count; drafts don't, because they have their own per-seat cap.
  - The proxy charges each attempt, retries included, through `chargeCall` before it calls Claude.
  - When the allowance is spent, the room ends with no deal (`stalled`, brief outcome `no_agreement`), like reaching the turn limit. `resume` and `hydrate` keep a spent room stalled. The reason is only in the log (`errorClass="BudgetError"`).
- **"Use our AI" access.** With sign-in on, the built-in Claude (a built-in seat, a card draft, the authority audit) is the owner's money and needs access. `createRooms` is handed `canUseAi(user)` and `isAdmin(user)` (`aiAccess.canUseAi` and `aiAccess.isAdmin` directly, or `() => false` with sign-in off): `lib/app.js` builds auth and `aiAccess` before the domain, with no late binding, and the domain never imports auth or `lib/ai-access.js`. `createLiveRoom` refuses a built-in seat on either seat, from the web or MCP, with 403 `ai_access` (`aiAccessRequired(publicUrl)`), and stamps `room.ai` (the opener's access then; `true` with sign-in off; no field on a demo or a room from before it). Only an explicit `room.ai === false` refuses: `chargeCall` is the one choke point (every Claude call, a draft included, passes it and throws 403 `ai_access` first), `draftCard` also checks it (before the draft allowance is used) and `finalise` skips `mapAuthority` (the brief handles a missing authority map), and the view sends `live: proxy.live() && room.ai !== false`. `hydrate()` coerces `room.ai`: `true` and `false` are kept, any other value is deleted (a missing field stays allowed: rooms from before the stamp were opened under the old rules). A deny or revoke does not stop a room already open (bounded by its allowance). Admins and granted users are exempt from the global `DAILY_ROOM_LIMIT` and their rooms do not increment `usage.total`; an admin has a finite per-account cap, `ADMIN_DAILY` (50, a constant in `lib/rooms.js`). `createRooms` is also handed `passcodeRequired()`; when it is false `checkPasscode` is skipped entirely, so no guess is counted and no address is locked out.

**Email** is three modules behind one interface:
- **`lib/mail.js`**: `createMailer({ config, secrets, log, clock, transport })` returns `sendMail({ to, toName, replyTo, subject, text, html, tag, fromName })`, `start()` (verifies the transport once at boot, in the background; a failure logs `mail.verify_failed` and turns sending off, the app keeps running), `status()`, `available()`, `outbox` and `close()` (called by `close` and `drain`). `sendMail` never throws: it returns `{ status: 'sent' | 'failed', messageId?, code?, permanent?, attempts }`. A bad message (an address, a header-breaking subject, an unknown tag) is `MAIL_INVALID` before the transport sees it. SMTP 4xx and connection failures are retried 3 times with backoff; 5xx, a rejected recipient, auth and TLS failures are permanent; a local timeout is never retried (the server may have taken it). Logs carry the tag and a code only, never an address, subject or reply text. `escapeHtml` is for every value put into an email's HTML.
- **`lib/mail-dev.js`** (`MAIL_TRANSPORT=dev`, the default) writes `<id>.json` and `<id>.html` (0600) to `<dataDir>/outbox`, keeps the newest 500, and serves `list()`/`read(id)` for `/dev/outbox`. `lib/http.js` serves that page only when `config.devOutbox` (off the platform); each email view gets its own sandboxed CSP with no script.
- **`lib/mail-smtp.js`** (`MAIL_TRANSPORT=smtp`) is the only file that requires `nodemailer`: pooled, `requireTLS` when not `secure`, TLS 1.2+, certificate checks on, per-phase timeouts, no file or URL access.

**`lib/view.js`**:
- `view(room, seat, token)` is the only thing sent to clients (REST, SSE and MCP). It must never leak the other seat's card, draft or token. Demo rooms are the deliberate exception: both seats share one token, so a single person drives both sides.
- `authSeat` accepts only an own-property seat `A` or `B`, and compares SHA-256 digests with `timingSafeEqual`.

**`lib/static.js`** serves the static files for `lib/http.js`: content-hash ETags (one per coding, 304 on a match), HTML and CSS have their local asset URLs stamped `?v=<hash of the served bytes>`, an asset requested with its current hash is cached `private, immutable` (HTML stays `no-cache`), text types are gzipped, and freshness is checked at most once a second (mtime and size).

**`lib/http.js`** is the HTTP layer:
- security headers and the CSP;
- routing and the REST API (`/key` is a short link: GET/HEAD with sign-in on answers 302 to `/connect#agent-keys`, otherwise it gets the normal 404);
- static pages, served from one data table, by `lib/static.js`;
- the SSE hub, which hears `onChange` and caps connections per room;
- the `/health` build fingerprint.

It never listens and never touches the store or the turn loop. The client IP comes from `lib/net.js`: `clientIp(req, trust)` returns a canonical address. It uses the last `X-Forwarded-For` entry only when `makeTrustProxy(TRUST_PROXY)` trusts the socket peer and the entry is a valid IP; otherwise it uses the socket address. `canonicalIp` is the single address grammar for both trust decisions and rate-limit keys. Static files resolve through `resolveStatic()`, which refuses any path that escapes `web/`. **`lib/errors.js`** holds the error classes (`ApiError` is an HTTP status, a client-safe message and an optional machine `apiCode`; also `ProxyError`, `BudgetError` and `AuthError`), factories for the shared refusals (`savingUnavailable`, `signinRequired`, …) and the MCP agent-key sentences, which are fixed per deploy (they name `<PUBLIC_URL>/key`, built by `keyPageUrl(publicUrl)`, which the MCP sign-in text uses too).

**Sign-in** (`SIGNIN=github`) is four modules:
- **`lib/auth.js`** works on plain values: no request, no response, no cookie. GitHub OAuth with PKCE S256 and no scope; a state works once; the GitHub token is used for one profile read and dropped. Records: `user` by GitHub id; `session` and `agentkey` by the SHA-256 of their token, which is never stored. A session lasts 7 days idle and 30 at most; an agent key ends after 90 days unused. A user holds up to 10 live agent keys (`MAX_KEYS_PER_USER`; idle ones are dropped before counting), each with a `name` (optional, up to 40 code points after cleaning by `lib/text.js`; empty means none; unique among the user's live keys, ignoring case) and a `kid`, its public id, derived and never stored. A revoke names a `kid` and stays strict: a retry while saving fails answers 503 again. The index and the unconfirmed-write bookkeeping are described in the `lib/auth.js` header comment. Callbacks are rate-limited per address, and minting keys per user. Blocked ids (`GITHUB_BLOCKED_IDS`) count as absent everywhere.
- **`lib/durable.js`**: the "is it durable yet" bookkeeping. `createPersist({ store, canRevoke })` returns `persist(kind, ids)`, true only when the store confirms every record and false, without trying, while `canRevoke()` is false; it keeps no state, and `lib/ai-access.js` uses it alone. `createDurable({ store, canRevoke })` adds the owed list, `{ durable(kind, ids, userId), unconfirmed }`, which `lib/auth.js` keeps. Behaviour is pinned by the auth and ai-access tests.
- **`lib/rate.js`**: `createRateTable`, the fixed-window counter from a capped table that `lib/auth.js` and `lib/ai-access.js` share.
- **`lib/ai-access.js`**: `createAiAccess({ store, config, canRevoke, userInfo, clock, log, notify })` owns the `aiaccess` collection (by user id: `{ status, note, requestedAt, decidedAt, decidedBy }`; `decidedBy` is the deciding admin's user id, stored and never logged). `status(user)` (an admin from `ADMIN_GITHUB_IDS` is always `granted`; only the exact status `granted` grants, anything damaged reads `none`: fail closed), `canUseAi`, `isAdmin`, `request(user, note)` (note cleaned by `lib/text.js`, 280 code points; only none and requested change; its own rate table of 5 per user per 10 minutes; 500 pending at most, counted by a running set kept in `request`, `decide` and at load), `list()` (every pending request, then every grant, then denied rows newest first; only the denied rows are capped, at 500) and the strict, durable `decide(userId, decision, decidedBy)`. A grant takes effect only once the store confirms it: the record is written to the map (the store saves what the map holds) but sits in an in-flight set that `status()` ignores until `persist` returns true; a failed grant is rolled back only if the map still holds the very record it wrote (a deny, reset or request that came in meanwhile is never undone). A deny or reset holds in memory at once. Persistence is `createPersist` from `lib/durable.js`; ai-access keeps no owed list. Each confirmed decision logs one event with no fields: `ai.granted`, `ai.denied` or `ai.reset`. `auth.userInfo(userId)` gives it the login and hides blocked users. `notify` is a no-op hook for a later mail item.
- **`lib/http-auth.js`** owns the cookies and routes: `GET /auth/github`, `GET /auth/github/callback`, `POST /auth/logout`, `GET /api/me`, `POST /api/me/agent-key` (`{name}`: required, `''` for none, so an old page cannot mint by mistake; a refused name is a 400 `key_name` or `key_name_taken`, too many keys a 409 `key_limit`, and these are answered before the rate limit is asked) and `POST /api/me/agent-key/revoke` (`{kid}`; a missing or malformed kid is a 400 with no code), `POST /api/me/ai-access` (`{note?}`: 200 `{ status }`; 400 `ai_note`, 429 `rate_limited`, 503 `requests_full`) and the admin routes in `handleAdmin`, `GET` and `POST /api/admin/ai-access`. `GET /api/me` also has `ai` (`granted`, `requested`, `denied`, `none`) and `admin`. The admin GET checks the session only (a browser's GET carries no Origin), then `isAdmin`; the admin POST resolves the session and `isAdmin` first (404), then `requireUser` (Origin 403, JSON 415, session 401), the body, and `requireUser` and the admin check again. A non-admin (signed out included) gets a plain 404 from both, POST included: never a 401, 403 or 415. With sign-in off `lib/http.js` does not dispatch `/api/admin` at all (`signinOn && parts[1] === 'admin'`), so it falls through to normal routing. A decision logs `ai.granted`, `ai.denied` or `ai.reset` with no fields: no user id, no admin id and never the note (the admin id is stored as `decidedBy`). The two key routes read their body through the injected `readObject` and re-run `requireUser` after it, as `POST /api/rooms` does. Two `__Host-` cookies, both HttpOnly, Secure, SameSite=Lax: the OAuth state (10 minutes) and the session (30 days). `requireUser(req)` guards every cookie-authenticated action that needs a user: an `Origin` equal to `PUBLIC_URL`'s (403), a JSON content type (415), and a valid session (401). Logout passes the first two checks only, so it works with an expired session. With sign-in off, only `GET /api/me` answers, as signed out. `/mcp` never reads a cookie.

**`ops`** is the shared operations object passed to `lib/mcp.js`, so the web API and MCP call the same functions. Its members are frozen: all synchronous except `externalTurn`, and `lib/mcp.js` does not await them. `signinOn` and `userForAgentKey(key)` (the key's `{ id, login }`, or null) serve the agent-key check. `passcodeRequired` is decided once in `lib/app.js` (`Boolean(secrets.passcode) && !signinOn`), and `passcodeMatches` follows it: a signed-in person needs no passcode, and `/api/config` reports `passcode: false` with sign-in on. A `ROOM_PASSCODE` set with `SIGNIN=github` is ignored, and boot logs the warning `app.passcode_ignored` (and keeps running).

**`lib/pxp.js`** is the protocol core: canonical JSON, SHA-256 sealing, the ledger and envelope enforcement. `buildEnvelope` converts untrusted raw proxy output into a valid envelope and applies the rules **server-side**, recording each violation in `protocol_flags`. For example, `stated`/`sourced` with no `ref` is downgraded to `assumed`, and citing the other side as `stated` is downgraded. Agreeing while raising a conflict, or accepting a proposal whose `depends_on` includes a claim you disputed, is withheld unless your principal answered an escalation after the dispute. Ledger hashes are computed as `sha256(prev + canonical({n,type,at,data}))`. If you change that formula or the shape of ledger entries, `verifyLedger` fails for every room already persisted.

**`lib/proxy.js`** calls the Claude API directly with `fetch` (no SDK).

`createProxy({ apiKey, model, fetch, clock, log, beforeCall, timeouts })` returns `{ live(), MODEL, draftCard, takeTurn, mapAuthority }`.

Prompts:
- `CARD_SYSTEM` drafts an Intent Card from a brief.
- `turnSystem` takes one negotiation turn, JSON out.
- `AUTH_SYSTEM` maps each agreed term to the card clause that authorised it, for the brief.

`parseJson` tolerates code fences and surrounding prose. Rules that matter when you change it:
- **Retries.** Only `takeTurn` retries:
  - **Limits:** at most 3 attempts, with jittered backoff, inside a 120 s deadline.
  - **What is retried:** 429, 529, 500, 502, 503 and 504, and connection errors that fail before any byte is sent.
  - **What is never retried:** a local timeout, a malformed reply, or a socket error after the request went out. Each of those may already be billed.
- **Spend hook.** `beforeCall(room, kind)` runs before every attempt. It is the spend hook, and whatever it throws passes through unchanged.
- **Errors.** Every failure is a `ProxyError`. Its message comes only from the HTTP status and an allowlisted Claude error type. The key, the request and Claude's free-text error message never appear in an error or a log.

**`lib/mcp.js`** is a stateless Streamable-HTTP MCP server at `/mcp`. It returns JSON responses only and has no server-initiated stream (GET returns 405). The seat link (`/room/ID?seat=A&t=TOKEN`) is the credential for everything in a room. With sign-in on, `create_room` also needs the person's agent key as `Authorization: Bearer <key>` (the scheme is case-insensitive). It is resolved on every request and refused before the domain with a sentence that is fixed per deploy (`AGENT_KEY_MISSING` / `AGENT_KEY_REJECTED`; each names `<PUBLIC_URL>/key`, as do the sign-in `INSTRUCTIONS` and the `create_room` text). The `INSTRUCTIONS` and tool text depend on the mode; with sign-in off they are unchanged. `wait_for_turn` long-polls for at most 25s. A JSON-RPC batch is capped at `MAX_BATCH` (20): a larger batch gets HTTP 400 with `-32600`, and none of its messages are dispatched. MCP session IDs exist only to remember the client's name for the seat label.

**`lib/demo.js`** holds the scripted "hallucination cascade" scenario. Its scripted raw outputs pass through the same `buildEnvelope` enforcement as live turns. The escalation answer chooses a branch (`dedupe` / `accept`), and that branch's script then replaces `room.script`.

**`web/`** holds static pages in plain HTML and JS, with no framework or build step. Every page runs on the UI library (`web/ui/`), and its script lives in `web/js/`, with no inline scripts.

**Pages:**

| Page | URL |
|---|---|
| Home | `/` |
| Start → Invite | `/start` |
| Room | `/room/:id` |
| Agreement | `/brief/:id` |
| Connect | `/connect` |
| Admin | `/admin` |
| Protocol | `/spec` |
| Style guide | `/ui` |

**Shared modules.** These are pure, return data only, and are unit-tested in Node:
- `room-view.js` holds every room step choice, status label and sentence.
- `agreement-view.js` does the same for the agreement page.
- `links.js` owns seat credentials and every room or brief link.
- `markdown.js` is the safe spec renderer.
- `account-view.js` holds the sign-in wording: the header account slot, the start prompt and the agent-key panel (`parseMe`, `slot`, `keyPanel`).
- `admin-view.js` does the same for the admin page (the request rows, the decisions and `errorMessage('adminDecide', ...)`). The page is for admins only; a non-admin sees the same "not found" the server gives.

`account.js` is the one stateful page module: it asks `/api/me` once, in parallel with the settings (with sign-in off the settings decide and its answer is ignored), fills the header's account slot, and tells subscribers when the answer changes. The account slot sits after the main nav on home, connect, spec and admin; it is empty and hidden with sign-in off.

**The room page** is split into five scripts, loaded in this order:
1. `room-core.js`: state, credentials, post/refresh and the live stream
2. `room-kit.js`: shared markup and the `act()` action flow
3. `room-setup.js`: welcome, instructions, ready and demo intro
4. `room-chat.js`: the conversation
5. `room.js`: the controller

How the room page talks to the server:
- It listens to SSE at `/api/rooms/:id/events`.
- It posts seat actions to `/api/rooms/:id/seats/:seat/(draft|seal|answer|resume)` with the token in the body.
- It re-renders a message only when its fingerprint changes. A message can change after it first appears, for example when a later review or answer lands.

**Content security policy.** Every response sends a strict CSP (`default-src 'self'`, with no inline script or style). Keep every page free of inline code; `test/pages.test.js` enforces this.

## UI library

`web/ui/` is the zero-dependency UI library. It contains:
- **`ui.css`:** tokens and components, in `@layer`s.
- **`ui.js`** (`window.UI`):
  - safe HTML: `html`, `render`, `url`, `esc`
  - requests: `request`, `loadConfig` (resolves `{ live, passcode, signin }`)
  - controls and forms: `setBusy`, `disableAll`, `byId`, `copyField`, `fieldError`, `describedBy`
  - messages and icons: `callout`, `alertBox`, `icon`, `toast` (visible feedback), `announce` (screen-reader only)
  - clipboard: `copy`
  - theme: `setTheme`, `getTheme`
- **`theme.js`:** applies the stored theme before first paint.
- A self-hosted variable font, and `logo.svg`.

**`/ui` is the living style guide and the reference for every component.**

Every page links `/ui/ui.css`. The old `style.css` is gone.

- **Page chrome:** headers and footers are copied verbatim on each page, and a test checks they match.
- **Wording:** page scripts hold no reader-facing wording. It comes from the view modules.

- **Tokens only:** components read colour through tokens. Literal colours live only in the light `:root` block and the two identical, screen-only dark blocks. Every pair in `test/contrast-pairs.json` must pass WCAG in both themes. Add a pair there when you introduce one.
- **Safe HTML:** build markup with `UI.html` and pass URLs through `UI.url`. There is deliberately no string-to-trusted escape hatch, because the other seat's agent controls text on a page that holds this seat's token. `UI.render(el, safe)` is the only `innerHTML` sink: it accepts only `UI.html` output, and pages never assign `innerHTML` themselves.
- **Plain language:** user-facing copy has no protocol jargon. Say "Your AI", "Not confirmed", "Locked" and "Deal reached". Hashes and the ledger go behind a "Details" disclosure.
- **Seat colour is fixed by seat** (`.party-a` blue, `.party-b` rust), never by viewer. Copy says "Your AI" where the page knows the viewer's seat.
- **Footers:** full on reading pages (home, connect), slim on stopping points (invite, agreement), and none on task pages.
- **URLs:** never hard-code the deploy hostname in `web/`. It comes from `PUBLIC_URL` and changes per deploy.

## Keep in sync

The protocol rules are written out in several places. A rule change has to touch all of them:
- `spec/SPEC.md` and `spec/*.schema.json`. These are a copy of the canonical `v0/` in the `JulesNsenda/pxp` repo (published at https://julesnsenda.github.io/pxp/). Change the spec there first, then copy it here byte for byte, because the schemas' `$id`s point at the published URLs. `/spec` serves this local copy, since the CSP forbids fetching it from elsewhere
- the enforcement in `lib/pxp.js` (`buildEnvelope`)
- the built-in proxy prompt (`turnSystem` in `lib/proxy.js`)
- the MCP `INSTRUCTIONS` and the tool schemas in `lib/mcp.js`
- the demo script in `lib/demo.js`, if the rule changes how the scripted turns behave
- the plain-language wording in `web/js/room-view.js`, if `buildEnvelope`'s `protocol_flags` text or the card fields change. Flag sentences are matched against the server's fixed text, and a test counts the flag rules.

The client-facing error sentences live in `lib/rooms.js`:
- the AI-service and generic `room.error` sentences (the `ROOM_ERRORS` set);
- the draft 502.

`hydrate()` keeps only that fixed set when it loads `room.error`. If you add a sentence, add it there too.

`web/js/room-view.js` `errorMessage(action, status, code)` has its own sentence for each refusal an action can get. Refusals with a machine code are listed by hand in `test-support/refusals.js` `EXPECTED`; its census finds every code the server can send (`ApiError` third arguments, `lib/errors.js` exports and factories, `*_limit` literals), and a test fails on any code that isn't accounted for. Refusals without a code are matched by status.

Sign-in has three pairs to keep together:
- the MCP agent-key header, the mode-dependent `INSTRUCTIONS` in `lib/mcp.js`, and `spec/SPEC.md` §8;
- the refusal sentences in `lib/errors.js` factories and `errorMessage`'s codes (`ai_access` for `create` and `draft`; `ai_note`, `rate_limited`, `requests_full` for the AI request; `adminDecide`'s codes in `admin-view.js`);
- `SIGNIN_NEXT` in `web/js/account-view.js` and the paths `beginLogin` allows in `lib/auth.js` (`NEXT_PATHS`: `/`, `/start`, `/connect`, `/key`, `/admin`; a test compares them).

Deploy and configuration have more places to keep together:
- the deploy hostname `behalf.dropkit.sh`: the `PUBLIC_URL` default in `lib/config.js`, `drop.yaml` (the `env` value and the secret description), the README (the `PUBLIC_URL` row, deploy steps 1 and 3, and the `claude mcp add` line), `server.json` (the MCP Registry entry), the MCP refusals and sign-in instructions (they name `PUBLIC_URL/key`, built per call from the config) and, outside the repo, the callback URL of the GitHub OAuth app. A redeploy that changes the URL touches all of them;
- the access settings: `ADMIN_GITHUB_IDS` in `lib/config.js` (dashboard only, not in `drop.yaml`), the `app.no_admins` and `app.passcode_ignored` warnings in `lib/app.js`, `ADMIN_DAILY` in `lib/rooms.js`, the README row, deploy step 2 and the "Use our AI" section, and the `aiaccess` row of `KIND` in `lib/store-core.js` (the file key, the Postgres kind and the log's `kind` allowlist all follow it);
- the create_room description in `lib/mcp.js` for sign-in mode (the no-passcode and "Use our AI" clauses; the `inputSchema` stays identical in both modes), `SERVER_INFO.version` and `server.json` (both 0.3.0), pinned by `test/registry.test.js`;
- the secrets: `SECRET_NAMES` and the `loadSecrets` fields in `lib/config.js`, `redacted()`, the `secrets:` in `drop.yaml`, `checkSignin`, `checkMail`, and the README rows;
- the mail settings: `loadConfig` and `checkMail` in `lib/config.js`, the README rows and refusal codes, `MAIL.md`, and `MAIL_TRANSPORT` in `drop.yaml`;
- the database guard: the `REQUIRE_DATABASE` default in `lib/config.js`, `drop.yaml` `env:`, the README row, deploy paragraph and *Rolling back*, and `baseEnv` in `test-support/server.js`;
- the drain timing: `DRAIN_DEADLINE_MS` (`lib/config.js`), `STATEMENT_MS` and the release limits in `lib/store-pg.js`, and the platform's kill timeout (Drop: PM2 5 s, Docker 10 s). The statement timeout stays under the drain default, and the drain default under the kill timeout;
- the README "Startup refusals" table and the `StoreError` and `ConfigError` codes in `lib/store-core.js`, `lib/store.js`, `lib/store-pg.js` and `lib/config.js`. The table covers the common cases, not every code;
- the record kinds: `rowsToDoc` (`lib/store-pg.js`) and `scripts/export-rooms.js` read the kind table in `lib/store-core.js`, so a new kind goes in `KIND` and nowhere else.

The shared writing guidance (`lib/writing.js`) is presentation guidance, not a protocol rule. It is interpolated into `turnSystem`, the MCP `INSTRUCTIONS` and `AUTH_SYSTEM`. Change it in that one place.
