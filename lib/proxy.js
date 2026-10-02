'use strict';
// Proxy brains: Claude calls for drafting cards, taking turns, and mapping authority.
const { str } = require('./pxp');
const { PLAIN_WRITING, BANNED_LIST } = require('./writing');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.PXP_MODEL || 'claude-sonnet-5-5';

function live() { return Boolean(API_KEY); }

async function callClaude(system, user, maxTokens = 1800) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(data.error && data.error.message) || 'request failed'}`);
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    return parseJson(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Proxy did not return JSON');
  return JSON.parse(body.slice(start, end + 1));
}

const CARD_SYSTEM = `You convert a person's plain-language brief into a PXP Intent Card (JSON).
Rules:
- Use the person's own meaning. Do NOT invent constraints, numbers, or facts they did not state or clearly imply.
- If something important is missing, leave the list short rather than guessing.
- must_never: hard limits only. escalate_when: situations where the proxy must stop and ask.
- known_facts: only facts the person asserted.
Return ONLY JSON:
{"principal":{"name":"","role":"","org":""},"goal":"","must_haves":[],"may_agree_to":[],"must_never":[],"escalate_when":[],"known_facts":[]}`;

async function draftCard({ name, role, topic, text }) {
  const user = `Room topic: ${topic}\nPerson: ${name}${role ? ` (${role})` : ''}\n\nTheir brief:\n${text}`;
  return callClaude(CARD_SYSTEM, user, 1200);
}

function cardForPrompt(card) {
  const lines = [`principal: ${card.principal.name}${card.principal.role ? ', ' + card.principal.role : ''}`, `goal: ${card.goal}`];
  for (const f of ['must_haves', 'may_agree_to', 'must_never', 'escalate_when', 'known_facts']) {
    card[f].forEach((v, i) => lines.push(`${f}[${i}]: ${v}`));
  }
  (card.amendments || []).forEach((a, i) => lines.push(`amendment[${i}]: Q: ${a.question} A: ${a.answer}`));
  return lines.join('\n');
}

function transcriptForPrompt(room) {
  if (!room.envelopes.length) return '(no messages yet; you open the exchange)';
  return room.envelopes.map(e => {
    const parts = [`#${e.seq} from seat ${e.from.seat} (${e.from.principal}'s proxy) status=${e.status}`, `message: ${e.message}`];
    e.claims.forEach(c => parts.push(`  claim ${c.id} [${c.origin}${c.ref ? ' ref=' + c.ref : ''}]: ${c.text}`));
    e.reviews.forEach(v => parts.push(`  review of ${v.claim_id}: ${v.verdict}${v.reason ? ' because ' + v.reason : ''}`));
    if (e.proposal) parts.push(`  PROPOSAL terms: ${e.proposal.terms.map((t, i) => `(${i + 1}) ${t}`).join(' ')} | depends_on: ${e.proposal.depends_on.join(', ') || 'none'}`);
    if (e.accepts) parts.push(`  ACCEPTS proposal from #${e.accepts.seq}`);
    if (e.escalation) parts.push(`  escalated to principal: ${e.escalation.question}`);
    if (e.answer) parts.push(`  principal answered: ${e.answer}`);
    return parts.join('\n');
  }).join('\n\n');
}

function turnSystem(room, seatId) {
  const seat = room.seats[seatId];
  const other = room.seats[seatId === 'A' ? 'B' : 'A'];
  return `You are a PXP proxy: an AI agent representing ${seat.card.principal.name} in a negotiation with the proxy of ${other.card.principal.name}.
Room topic: ${room.topic}

YOUR PRINCIPAL'S SEALED INTENT CARD (private; share only what is needed):
${cardForPrompt(seat.card)}

PROTOCOL RULES (Proxy Exchange Protocol v0):
1. Every fact you rely on is a claim with an origin:
   - "stated": your principal said it. ref MUST name the card clause, e.g. "must_never[0]" or "amendment[0]".
   - "sourced": from a named document/system. ref MUST name the source.
   - "assumed": you are inferring it. Be honest: if nobody told you, it is assumed.
2. Anything the other proxy claimed is NEVER "stated" for you. Repeating it does not make it true.
3. Review every claim from the other side you have not reviewed yet: accept / challenge (cannot verify) / conflict (contradicts your card).
4. You MUST escalate (status "escalate", one concrete question for your principal) when: agreeing would cross must_never or go beyond may_agree_to; an escalate_when condition matches; a conflict cannot be resolved within your authority; or a proposal relies on an unverified assumption that affects a must_have.
5. To propose, include proposal.terms. To accept the other side's latest proposal exactly, set status "agree" (do not include a proposal). Never agree while raising a conflict.
6. Be concise and concrete. Converge within a few turns. Do not reveal private limits (like maximum budgets) unless necessary.

HOW TO WRITE FOR THE PEOPLE READING:
${PLAIN_WRITING}

Return ONLY JSON:
{"message":"what you say to the other proxy (2-4 sentences)",
 "claims":[{"text":"","origin":"stated|sourced|assumed","ref":""}],
 "reviews":[{"claim_id":"B1.2","verdict":"accept|challenge|conflict","reason":""}],
 "proposal":{"terms":["..."],"depends_on":["claim ids these terms rely on; use new1,new2 for claims in this message"]},
 "status":"continue|agree|escalate",
 "escalation":{"question":"","reason":""}}
Omit proposal or escalation when not used.`;
}

async function takeTurn(room, seatId) {
  const unverified = Object.values(room.claims).filter(c => !c.verified).map(c => `${c.id}: ${c.text}`);
  const user = `TRANSCRIPT SO FAR:\n${transcriptForPrompt(room)}\n\nUNVERIFIED ASSUMPTIONS IN THE ROOM:\n${unverified.join('\n') || '(none)'}\n\nYou are seat ${seatId}. Take your turn (turn ${room.turnCount + 1} of max ${room.maxTurns}).`;
  return callClaude(turnSystem(room, seatId), user, 1800);
}

const AUTH_SYSTEM = `You audit an agreement made by two AI proxies. For each agreed term, say what authorised each side to accept it.
For each side answer one of: "must_haves", "may_agree_to", "known_facts", "amendment" (the principal answered an escalation), or "none" (nothing in the card covers it).
Be strict: if the card does not clearly cover the term, answer "none".
The "note" is read by either person. Write it as one short, plain sentence in the third person, using first names and never "you" or "your". Avoid claim IDs, field names and the words ${BANNED_LIST}.
Return ONLY JSON: {"terms":[{"term":"","A":"","B":"","note":""}]}`;

async function mapAuthority(room, terms) {
  const user = `SEAT A CARD:\n${cardForPrompt(room.seats.A.card)}\n\nSEAT B CARD:\n${cardForPrompt(room.seats.B.card)}\n\nAGREED TERMS:\n${terms.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
  const out = await callClaude(AUTH_SYSTEM, user, 1200);
  const ok = new Set(['must_haves', 'may_agree_to', 'known_facts', 'amendment', 'none']);
  return terms.map((t, i) => {
    const m = (out.terms || [])[i] || {};
    return { term: t, A: ok.has(m.A) ? m.A : 'none', B: ok.has(m.B) ? m.B : 'none', note: str(m.note, 200) };
  });
}

module.exports = { live, draftCard, takeTurn, mapAuthority, MODEL };
