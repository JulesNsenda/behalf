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
```

Without `ANTHROPIC_API_KEY`, the scripted demo and rooms where both seats are "bring your own agent" (MCP) still work. Built-in Claude proxies, card drafting and the authority audit need the key. The other env vars are in the README table. State persists to `$DROP_DATA_DIR/rooms.json`, or `./.data/rooms.json` when that variable isn't set. Delete that file to reset.

Deployment: `drop.yaml` targets the Drop platform (`type: nodejs`, health check `/health`). Compare the `build` fingerprint from `/health` with a local run to confirm a deploy matches the local tree.

## Architecture

**`index.js`** is the HTTP server and holds all room state. It owns:
- **Persistence**: an in-memory `rooms` Map, flushed to disk by a debounced `save()` (atomic tmp+rename). On load, the transient fields `running` and `thinking` are reset, and a built-in turn that was cut off by a restart becomes `status: 'paused', interrupted: true`.
- **The turn loop**: `run(room)` drives built-in proxies until one of agreement, escalation, `maxTurns` (stalled), an error, or a turn owned by an **external** seat. For an external seat it sets `waitingOn` and returns. The external agent then calls in through `externalTurn()`, which re-enters `run()`. `room.running` is the re-entrancy guard.
- **`advance()`**: the single path every proxy turn goes through, whether it comes from built-in Claude, the demo script or an MCP agent. It calls `pxp.buildEnvelope` and `pxp.applyEnvelope`, then handles the escalate, agree or continue transition.
- **`view(room, seat, token)`**: the only thing sent to clients (REST, SSE and MCP). It must never leak the other seat's card, draft or token. Demo rooms are the deliberate exception: both seats share one token, so a single person drives both sides.
- **`ops`**: the shared operations object passed to `lib/mcp.js`, so the web API and MCP call the same functions.

**`lib/pxp.js`** is the protocol core: canonical JSON, SHA-256 sealing, the ledger and envelope enforcement. `buildEnvelope` converts untrusted raw proxy output into a valid envelope and applies the rules **server-side**, recording each violation in `protocol_flags`. For example, `stated`/`sourced` with no `ref` is downgraded to `assumed`, and citing the other side as `stated` is downgraded. Agreeing while raising a conflict, or accepting a proposal whose `depends_on` includes a claim you disputed, is withheld unless your principal answered an escalation after the dispute. Ledger hashes are computed as `sha256(prev + canonical({n,type,at,data}))`. If you change that formula or the shape of ledger entries, `verifyLedger` fails for every room already persisted.

**`lib/proxy.js`** calls the Claude API directly with `fetch` (no SDK). Prompts: `CARD_SYSTEM` (drafts an Intent Card from a brief), `turnSystem` (one negotiation turn, JSON out) and `AUTH_SYSTEM` (maps each agreed term to the card clause that authorised it, for the brief). `parseJson` tolerates code fences and surrounding prose.

**`lib/mcp.js`** is a stateless Streamable-HTTP MCP server at `/mcp`. It returns JSON responses only and has no server-initiated stream (GET returns 405). The seat link (`/room/ID?seat=A&t=TOKEN`) is the credential. `wait_for_turn` long-polls for at most 25s. MCP session IDs exist only to remember the client's name for the seat label.

**`lib/demo.js`** holds the scripted "hallucination cascade" scenario. Its scripted raw outputs pass through the same `buildEnvelope` enforcement as live turns. The escalation answer chooses a branch (`dedupe` / `accept`), and that branch's script then replaces `room.script`.

**`web/`** contains static pages written in plain HTML and JS, with no framework. `room.html` uses SSE (`/api/rooms/:id/events`) and posts seat actions to `/api/rooms/:id/seats/:seat/(draft|seal|answer|resume)` with the token in the body.

## UI library

`web/ui/` is the zero-dependency UI library: `ui.css` (tokens + components, in `@layer`s), `ui.js` (`window.UI`: `esc`, `html`, `url`, `render`, `copy`, `toast`, `setTheme`, `getTheme`), `theme.js` (applies the stored theme before first paint), a self-hosted variable font, and `logo.svg`. **`/ui` is the living style guide and the reference for every component.** The existing pages still use `style.css`. Moving them over is a separate plan, and a page loads one stylesheet or the other, never both (a test enforces this).

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
