# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Proxy Room is the reference implementation of **PXP v0 (Proxy Exchange Protocol)**: two AI proxies negotiate for two humans, every claim is tagged `stated` / `sourced` / `assumed`, proxies escalate to their humans at a limit, and an agreement produces a decision brief plus a hash-chained ledger. `spec/SPEC.md` is the normative protocol, and the code implements it.

## Commands

Zero dependencies, Node 18+ (it uses global `fetch`). There is no build or lint step.

```sh
npm test                              # node:test suite in test/ (UI tokens + contrast, ui.js, server, pages)
node index.js                         # or: npm start  (PORT defaults to 3000; PORT=0 picks a free port, BIND_HOST is optional)
DEMO_DELAY_MS=200 node index.js       # speed up the scripted demo (default 2600ms per turn)
curl localhost:3000/health            # {ok, live, rooms, build}; build = hash of the source tree
curl -XPOST localhost:3000/api/demo   # create a scripted demo room, then open /room/<id>?seat=A&t=<token>
# Linux + Node 18, which also runs the POSIX-only tests. The repo is mounted read-only.
docker run --rm -v "$PWD:/app:ro" -w /app node:18 node --test
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/app:ro" -w /app node:18 node --test   # the same, from Git Bash on Windows
```

Without `ANTHROPIC_API_KEY`, the scripted demo and rooms where both seats are "bring your own agent" (MCP) still work. Built-in Claude proxies, card drafting and the authority audit need the key. The other env vars are in the README table. State persists to `$DROP_DATA_DIR/rooms.json`, or `./.data/rooms.json` when that variable isn't set. Delete that file to reset.

Deployment: `drop.yaml` targets the Drop platform (`type: nodejs`, health check `/health`). Compare the `build` fingerprint from `/health` with a local run to confirm a deploy matches the local tree.

## Architecture

The backend is a set of small `lib/` modules, each with one job, assembled in one place.

**`lib/app.js`** is the composition root. `createApp(overrides)` builds every part and wires them together:
- It reads the config and the secrets **once**.
- It loads the store and builds the proxy, the domain and the HTTP server.
- It assembles the `ops` object for `lib/mcp.js`.

Every dependency can be overridden (`config`, `secrets`, `log`, `store`, `proxy`, `fetch`, `timeouts`, `clock`, `demo`, …), so tests run the whole app in-process with fakes. `createApp` never exits the process. A store that can't load throws a `StoreError`.

**`index.js`** is a thin entry point. It does three things:
- calls `createApp()`;
- listens, printing the listen line, which `test-support/server.js` matches, so keep it byte for byte;
- maps `SIGTERM`/`SIGINT` to `app.shutdown()`, which flushes the store before exit.

**`lib/config.js`** reads the environment once:
- `loadConfig()` returns a frozen object of plain settings.
- `loadSecrets()` returns `ROOM_PASSCODE` and `ANTHROPIC_API_KEY`, redacted in `JSON.stringify` and `util.inspect`.

Secrets are never in the config object. `createApp` deletes both from `process.env` after reading them.

**`lib/log.js`** writes one line per event to stderr. Its rules:
- **Fields:** only allowlisted fields are written: room, seat, status, httpStatus, errorClass, code, durationMs, stack and reason (`reason` takes only `ttl` or `capacity`). A new field must be added to `ALLOWED`, and a test pins that list.
- **Messages:** an error's `message` is **never** logged, because it can echo model output or a card. Log errors as `log.error(event, fields, err)`. The logger takes the class, a vetted code and well-formed stack frames from `err`.

**`lib/store.js`** is persistence only. It holds the `rooms` Map and the daily `usage` in memory, and saves them to `rooms.json`. The rules:
- **How a save is written:** each room is serialised on its own, so one bad room can't block the save. The write goes to a temp file (mode 0600, `fsync`) and is then renamed over `rooms.json`, with retries on Windows.
- **Corrupt files:** a corrupt file is quarantined, and a room with a bad shape is preserved in a `.partial-<ts>` copy. Neither is silently dropped.
- **Unreadable files:** any other read failure stops startup rather than overwriting the file.
- **Schema versions:** a file with a newer `schemaVersion` is refused. Rolling back to an older build after a schema bump therefore crash-loops until the file is restored or migrated.

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

**`lib/view.js`**:
- `view(room, seat, token)` is the only thing sent to clients (REST, SSE and MCP). It must never leak the other seat's card, draft or token. Demo rooms are the deliberate exception: both seats share one token, so a single person drives both sides.
- `authSeat` accepts only an own-property seat `A` or `B`, and compares SHA-256 digests with `timingSafeEqual`.

**`lib/http.js`** is the HTTP layer:
- security headers and the CSP;
- routing and the REST API;
- static pages, served from one data table;
- the SSE hub, which hears `onChange` and caps connections per room;
- the `/health` build fingerprint.

It never listens and never touches the store or the turn loop. The client IP comes from `lib/net.js`: `clientIp(req, trust)` returns a canonical address. It uses the last `X-Forwarded-For` entry only when `makeTrustProxy(TRUST_PROXY)` trusts the socket peer and the entry is a valid IP; otherwise it uses the socket address. `canonicalIp` is the single address grammar for both trust decisions and rate-limit keys. Static files resolve through `resolveStatic()`, which refuses any path that escapes `web/`. **`lib/errors.js`** holds `ApiError`, a status code plus a client-safe message, and `ProxyError`.

**`ops`** is the shared operations object passed to `lib/mcp.js`, so the web API and MCP call the same functions. Its members are frozen: all synchronous except `externalTurn`, and `lib/mcp.js` does not await them.

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

**`lib/mcp.js`** is a stateless Streamable-HTTP MCP server at `/mcp`. It returns JSON responses only and has no server-initiated stream (GET returns 405). The seat link (`/room/ID?seat=A&t=TOKEN`) is the credential. `wait_for_turn` long-polls for at most 25s. A JSON-RPC batch is capped at `MAX_BATCH` (20): a larger batch gets HTTP 400 with `-32600`, and none of its messages are dispatched. MCP session IDs exist only to remember the client's name for the seat label.

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
| Protocol | `/spec` |
| Style guide | `/ui` |

**Shared modules.** These are pure, return data only, and are unit-tested in Node:
- `room-view.js` holds every room step choice, status label and sentence.
- `agreement-view.js` does the same for the agreement page.
- `links.js` owns seat credentials and every room or brief link.
- `markdown.js` is the safe spec renderer.

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
  - requests: `request`, `loadConfig`
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
- **URLs:** never hard-code the deploy hostname in `web/`. It changes with the Behalf rename.

## Keep in sync

The protocol rules are written out in several places. A rule change has to touch all of them:
- `spec/SPEC.md` and `spec/*.schema.json`
- the enforcement in `lib/pxp.js` (`buildEnvelope`)
- the built-in proxy prompt (`turnSystem` in `lib/proxy.js`)
- the MCP `INSTRUCTIONS` and the tool schemas in `lib/mcp.js`
- the demo script in `lib/demo.js`, if the rule changes how the scripted turns behave
- the plain-language wording in `web/js/room-view.js`, if `buildEnvelope`'s `protocol_flags` text or the card fields change. Flag sentences are matched against the server's fixed text, and a test counts the flag rules.

The client-facing error sentences live in `lib/rooms.js`:
- the AI-service and generic `room.error` sentences (the `ROOM_ERRORS` set);
- the draft 502.

`hydrate()` keeps only that fixed set when it loads `room.error`. If you add a sentence, add it there too. `web/js/room-view.js` `errorMessage()` has its own sentence for each status code an action can return, and a test counts those codes in the server source.

The shared writing guidance (`lib/writing.js`) is presentation guidance, not a protocol rule. It is interpolated into `turnSystem`, the MCP `INSTRUCTIONS` and `AUTH_SYSTEM`. Change it in that one place.
