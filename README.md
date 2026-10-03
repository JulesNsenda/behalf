# Behalf

Reference implementation of **PXP v0, the Proxy Exchange Protocol**: two AI proxies negotiate for two people, every claim is tagged stated / sourced / assumed, proxies escalate to their humans at a limit, and every agreement ships with a decision brief and a hash-chained ledger.

Based on the essay *Agentic Proxies: When Humans Become Routing Nodes* by Jules Nsenda.

- `spec/` — the protocol (SPEC.md + JSON schemas)
- `lib/pxp.js` — protocol core: sealing, envelope enforcement, ledger
- `lib/proxy.js` — Claude-backed proxies
- `lib/demo.js` — scripted demo (hallucination cascade), runs with no API key
- `lib/mcp.js` — MCP endpoint at `/mcp`, so any MCP-capable agent can take a seat
- `index.js` — zero-dependency Node server (Node 18+)
- `web/` — the pages:
  - Home (`/`)
  - Start (`/start`): create a room, then invite the other person
  - Room (`/room/:id`): instructions, then the conversation
  - Agreement (`/brief/:id`)
  - Connect (`/connect`)
  - Protocol (`/spec`)
- `web/ui/` — the zero-dependency UI library; its living style guide is at `/ui`
- `test/` — `npm test` (node:test, no dependencies)

## Config

| Env | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Enables built-in Claude proxies, card drafting and the authority audit. Without it, the demo and bring-your-own-agent rooms still work |
| `PXP_MODEL` | `claude-sonnet-5-5` | Model for proxies |
| `ROOM_PASSCODE` | none | If set, creating a live room requires it |
| `DAILY_ROOM_LIMIT` | 20 | Live rooms per day, all users |
| `PER_IP_DAILY` | 3 | Live rooms per day per IP |
| `MAX_TURNS` | 10 | Proxy turns before a room stalls |
| `PUBLIC_URL` | `https://behalf.dropkit.sh` | Base URL used in seat links handed to agents |
| `PORT` | 3000 | Listen port. `0` picks a free port, and the startup log prints the one it bound |
| `BIND_HOST` | all interfaces | Address to bind, e.g. `127.0.0.1`. It isn't called `HOST`, because some shells set `HOST` to the machine name |
| `ROOM_TTL_DAYS` | 30 | A live room is deleted after this many days without activity. Its links then show the room as gone |
| `DEMO_TTL_HOURS` | 24 | The same, for demo rooms |
| `MAX_ROOMS` | 5000 | Upper bound on stored rooms. When a new room would go past it, the server makes room down to 95%: demo rooms go first, oldest first, then finished live rooms. A live room still in progress is never deleted |
| `TRUST_PROXY` | `private` | When to trust `X-Forwarded-For` for the client IP. Choices: `never`; `loopback` (only when the peer is this machine, which is the safest choice when the proxy runs on the same host); `private` (a loopback or private-network peer, such as the platform's proxy); or `always`. `private` assumes no untrusted host on that network can reach the app port directly. Per-IP limits group IPv6 clients by /64. The server logs `net.xff_ignored` once if a forwarded header arrives from an untrusted peer: that is a spoof attempt, or a proxy outside the trusted set |

The last four are strict: an invalid value stops the server at startup, and the log names the variable but not its value. `ROOM_TTL_DAYS`, `DEMO_TTL_HOURS` and `MAX_ROOMS` must be whole numbers from 1 up to 3650, 87600 and 1,000,000 respectively. Each room also has an AI allowance of `MAX_TURNS × 3` Claude calls, and drafting a card doesn't count toward it. A room that uses it up ends with no deal, like reaching the turn limit.

State persists to `DROP_DATA_DIR/rooms.json`. On `SIGTERM` the server writes any pending changes before it exits. A newer build can upgrade the file's format. An older build refuses a file written by a newer one and won't start, so keep a copy of `rooms.json` from before an upgrade if you might need to roll back. Next to `rooms.json` the server can leave two kinds of recovery copies, and both can hold room content. If the file can't be parsed at all, it is moved aside as `rooms.json.corrupt-<time>` (the newest 5 are kept). If only some rooms fail to load, their original bytes are saved to `rooms.json.partial-<time>`, and those copies are never deleted, because each may be the only remaining copy of a room. Deleting a room from the server (eviction) doesn't delete these copies. Review them, and delete them yourself when they're no longer needed.
