# PXP — Proxy Exchange Protocol, v0 (draft)

Status: draft, reference implementation is Behalf. Expect breaking changes until v1.

## Why

When people route work through agents (Agent → Human → Agent → Human), each hop
reinterprets intent. Agents can confidently invent missing context, and other agents
can agree with it. PXP makes that drift visible and bounded. It answers seven
questions for every exchange: identity, authority, intent, constraints, provenance,
escalation, accountability.

PXP is transport-agnostic. It can ride on HTTP, A2A, or MCP. It specifies the
*content* proxies exchange, not how bytes move.

## Roles

- **Principal**: the human (or organisation) a proxy represents.
- **Proxy**: an agent acting for exactly one principal in an exchange.
- **Room**: one exchange between two or more proxies, with one shared ledger.

## 1. Intent Card (identity, authority, intent, constraints, escalation)

Written by the principal (Claude may draft it, the principal must confirm it).
Once confirmed it is **sealed**: its canonical JSON is hashed (SHA-256) and the hash
is recorded in the ledger. The card body stays private to its principal by default;
other parties see only the principal's display name and the card hash.

| Field | Meaning |
|---|---|
| `principal` | `{ name, role, org? }` — who the proxy speaks for |
| `goal` | One sentence: the outcome the principal wants |
| `must_haves[]` | Outcomes the proxy must secure |
| `may_agree_to[]` | Things the proxy may concede or accept without asking |
| `must_never[]` | Hard limits. Violating one is never allowed, only escalated |
| `escalate_when[]` | Conditions where the proxy must stop and ask its principal |
| `known_facts[]` | Facts the principal asserts as true (become `stated` claims) |
| `amendments[]` | Later answers from the principal, each sealed into the ledger |

Schema: `intent-card.schema.json`.

## 2. Envelope (one proxy message)

Every proxy message is an envelope:

```
{ room, seq, from: { seat, principal, speaker: "proxy" | "principal" },
  intent_hash, message, claims[], reviews[], proposal?, status, escalation? }
```

- `speaker` distinguishes the agent from the human. A principal's own answer is
  recorded with `speaker: "principal"`.
- `intent_hash` binds the message to the sealed card it acts under.
- `status`: `continue` | `agree` | `escalate`.

Schema: `envelope.schema.json`.

## 3. Claims and origin tags (provenance, semantic packet loss)

Every factual statement a proxy relies on is a **claim** with an origin:

| Origin | Meaning |
|---|---|
| `stated` | The proxy's own principal said it (card, known_facts, or amendment). Must cite `ref` |
| `sourced` | From a named document, system, or link. Must cite `ref` |
| `assumed` | The proxy inferred it. No principal or source backs it |

Rules:

1. A proxy **must** tag any claim it relies on. Untagged facts are protocol violations.
2. A claim received from another proxy is **never** `stated` for the receiver.
   Re-stating it does not upgrade its origin. This stops assumptions hardening into
   consensus across hops.
3. An `assumed` claim stays **unverified** until a principal confirms it or a source
   is attached. Unverified claims are carried into the final brief.

## 4. Reviews (the receiving side)

Before replying, a proxy reviews each new claim from the other side against its own
card:

- `accept` — consistent with my card and facts
- `challenge` — I can't verify it; asking for a source or confirmation
- `conflict` — contradicts my card (`must_never`, `must_haves`, or `known_facts`)

## 5. Escalation

A proxy **must** set `status: "escalate"` with a single concrete question when:

- an agreement would require crossing a `must_never` or something outside `may_agree_to`;
- any `escalate_when` condition matches;
- a `conflict` review cannot be resolved inside its authority;
- the proposed agreement depends on an `assumed` claim that touches a `must_have`.

The room pauses. The principal's answer is sealed as an amendment, recorded as a
`stated` claim with `speaker: "principal"`, and the exchange resumes.

## 6. Ledger (provenance, accountability)

Every event (card sealed, envelope, review, escalation, answer, agreement) is
appended to an append-only ledger. Each entry stores `prev` (hash of previous
entry) and `hash = SHA-256(prev + canonical(entry))`. The head hash identifies the
whole history; altering any entry breaks the chain.

## 7. Agreement and decision brief

A proposal is a binding offer from its proxy. An agreement is final when the other
proxy replies `status: "agree"`, which accepts that exact proposal (by `proposal_hash`)
and may not carry a counter-proposal or a `conflict` review. A proxy may not accept a
proposal whose `depends_on` includes a claim it has challenged or flagged as a conflict;
the dispute must first be resolved by escalating to its principal. A principal's answer
given after the dispute clears the block, but the claim stays unverified and appears in
the brief. The room then emits a
**decision brief**:

- what was agreed;
- on whose authority each term rests (card clause or principal amendment);
- unverified assumptions the agreement still depends on;
- escalations and how each principal answered;
- the ledger head hash.

Design test: a principal must be able to explain the outcome from the brief alone,
without reading the transcript.

## 8. Transport binding: MCP

A room is exposed as a remote MCP server (Streamable HTTP, JSON responses) so any
MCP-capable agent can act as a proxy. The seat link is the credential for everything in a room.
A server MAY require sign-in to open a live room. Then `create_room` needs the principal's agent key as an
HTTP header, `Authorization: Bearer <key>`, never as a tool argument. A missing or rejected key is refused as a
tool error with a fixed sentence, and the room is not created. Tools:
`create_room`, `join_room`, `seal_intent_card`, `get_room`, `wait_for_turn`,
`send_envelope`, `answer_escalation`, `get_brief`. An external proxy's envelopes pass
through the same enforcement as built-in ones, and the ledger records which agent sat in
each seat and whether a principal's answer arrived through the web or was relayed by
their agent (`via: "web" | "mcp"`).

In v0 a relayed answer is trusted as the principal's words. A later version should let
the principal confirm relayed answers out of band.

## Not in v0

Cryptographic signatures by principals (v0 seals with hashes on a trusted server), out-of-band confirmation of answers relayed by agents,
multi-party rooms (>2), payment authority, cross-room identity.
