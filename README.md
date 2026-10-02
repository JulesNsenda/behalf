# Proxy Room

Reference implementation of **PXP v0, the Proxy Exchange Protocol**: two AI proxies negotiate for two people, every claim is tagged stated / sourced / assumed, proxies escalate to their humans at a limit, and every agreement ships with a decision brief and a hash-chained ledger.

Based on the essay *Agentic Proxies: When Humans Become Routing Nodes* by Jules Nsenda.

- `spec/` — the protocol (SPEC.md + JSON schemas)
- `lib/pxp.js` — protocol core: sealing, envelope enforcement, ledger
- `lib/proxy.js` — Claude-backed proxies
- `lib/demo.js` — scripted demo (hallucination cascade), runs with no API key
- `lib/mcp.js` — MCP endpoint at `/mcp`, so any MCP-capable agent can take a seat
- `index.js` — zero-dependency Node server (Node 18+)

## Config

| Env | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Enables built-in Claude proxies, card drafting and the authority audit. Without it, the demo and bring-your-own-agent rooms still work |
| `PXP_MODEL` | `claude-sonnet-5-5` | Model for proxies |
| `ROOM_PASSCODE` | none | If set, creating a live room requires it |
| `DAILY_ROOM_LIMIT` | 20 | Live rooms per day, all users |
| `PER_IP_DAILY` | 3 | Live rooms per day per IP |
| `MAX_TURNS` | 10 | Proxy turns before a room stalls |
| `PUBLIC_URL` | `https://proxy-room.dropkit.sh` | Base URL used in seat links handed to agents |

State persists to `DROP_DATA_DIR/rooms.json`.
