'use strict';
// Proxy brains: Claude calls for drafting cards, taking turns, and mapping authority.
const { str } = require('./pxp');
const { PLAIN_WRITING, BANNED_LIST } = require('./writing');
const { ProxyError } = require('./errors');

const DEFAULT_TIMEOUTS = { attemptMs: 90000, deadlineMs: 120000, maxRetryAfterMs: 20000, baseBackoffMs: 1000, minAttemptMs: 15000 };
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
// Connection errors that fail before any byte is sent. ECONNRESET, ETIMEDOUT and UND_ERR_SOCKET are left out: they can
// come after the body was sent, and that request is billed.
const RETRY_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
const ERROR_TYPES = new Set(['overloaded_error', 'rate_limit_error', 'api_error', 'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large']);
const SYSTEM_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const NOOP_LOG = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Seconds, or an HTTP date; null when absent or unreadable.
function retryAfterMs(value, nowMs) {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
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

async function draftCard(call, { room, name, role, topic, text }) {
  const user = `Room topic: ${topic}\nPerson: ${name}${role ? ` (${role})` : ''}\n\nTheir brief:\n${text}`;
  return call(room, { kind: 'draft', system: CARD_SYSTEM, user, maxTokens: 1200 });
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

async function takeTurn(call, room, seatId) {
  const unverified = Object.values(room.claims).filter(c => !c.verified).map(c => `${c.id}: ${c.text}`);
  const user = `TRANSCRIPT SO FAR:\n${transcriptForPrompt(room)}\n\nUNVERIFIED ASSUMPTIONS IN THE ROOM:\n${unverified.join('\n') || '(none)'}\n\nYou are seat ${seatId}. Take your turn (turn ${room.turnCount + 1} of max ${room.maxTurns}).`;
  return call(room, { kind: 'turn', system: turnSystem(room, seatId), user, maxTokens: 1800 }, { retry: true });
}

const AUTH_SYSTEM = `You audit an agreement made by two AI proxies. For each agreed term, say what authorised each side to accept it.
For each side answer one of: "must_haves", "may_agree_to", "known_facts", "amendment" (the principal answered an escalation), or "none" (nothing in the card covers it).
Be strict: if the card does not clearly cover the term, answer "none".
The "note" is read by either person. Write it as one short, plain sentence in the third person, using first names and never "you" or "your". Avoid claim IDs, field names and the words ${BANNED_LIST}.
Never quote, paraphrase or reveal what either person's instructions say. The note only names which instruction allowed the term, in general words.
Return ONLY JSON: {"terms":[{"term":"","A":"","B":"","note":""}]}`;

async function mapAuthority(call, room, terms) {
  const user = `SEAT A CARD:\n${cardForPrompt(room.seats.A.card)}\n\nSEAT B CARD:\n${cardForPrompt(room.seats.B.card)}\n\nAGREED TERMS:\n${terms.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
  const out = await call(room, { kind: 'authority', system: AUTH_SYSTEM, user, maxTokens: 1200 });
  const ok = new Set(['must_haves', 'may_agree_to', 'known_facts', 'amendment', 'none']);
  return terms.map((t, i) => {
    const m = (out.terms || [])[i] || {};
    return { term: t, A: ok.has(m.A) ? m.A : 'none', B: ok.has(m.B) ? m.B : 'none', note: str(m.note, 200) };
  });
}

// Terminal log events, mutually exclusive per call: proxy.failed (any terminal failure) and proxy.gave_up (retries
// exhausted or refused). proxy.retry is a warning for each retry.
// beforeCall(room, kind) runs before every HTTP attempt, retries included, so a spend cap can refuse a call; whatever it
// throws propagates unchanged, with no retry and no log. Only takeTurn retries; a local abort is never retried because
// the call may still be billed.
function createProxy({ apiKey, model, fetch = globalThis.fetch, clock = {}, log = NOOP_LOG, beforeCall = () => {}, timeouts = {} } = {}) {
  const t = Object.assign({}, DEFAULT_TIMEOUTS, timeouts);
  const now = clock.now || Date.now;
  const wait = clock.sleep || sleep;

  async function attempt({ system, user, maxTokens }, deadline) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(0, Math.min(t.attemptMs, deadline - now())));
    try {
      let res;
      try {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
        });
      } catch (e) {
        if (e && e.name === 'AbortError') throw new ProxyError('Claude API request timed out');
        // Carry only a vetted code, never the raw error: undici messages can embed header values, including the key.
        const code = e && e.cause && typeof e.cause.code === 'string' && SYSTEM_ERROR_CODE.test(e.cause.code) ? e.cause.code : undefined;
        const err = new ProxyError('Claude API request failed', undefined, code && { code });
        err.retryable = RETRY_CODES.has(code);
        throw err;
      }
      const parsed = await res.json().catch(() => ({}));
      if (ctrl.signal.aborted) throw new ProxyError('Claude API request timed out');
      const data = parsed !== null && typeof parsed === 'object' ? parsed : {};
      if (!res.ok) {
        const type = data.error && data.error.type;
        const err = new ProxyError('Claude API ' + res.status + ': ' + (ERROR_TYPES.has(type) ? type : 'request failed'), res.status);
        err.retryable = RETRY_STATUSES.has(res.status);
        err.retryAfter = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
        throw err;
      }
      try {
        const blocks = Array.isArray(data.content) ? data.content : [];
        return parseJson(blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n'));
      } catch (e) {
        throw new ProxyError('Proxy did not return JSON');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function callClaude(room, request, { retry = false } = {}) {
    const started = now();
    const deadline = started + t.deadlineMs;
    const fields = (err) => ({ room: room && room.id, httpStatus: err.httpStatus, durationMs: now() - started });
    const failed = (err) => { log.error('proxy.failed', fields(err), err); return err; };
    if (!apiKey) throw failed(new ProxyError('ANTHROPIC_API_KEY is not set'));
    if (!room) throw failed(new ProxyError('A room is required for a Claude call'));
    for (let n = 1; ; n++) {
      // outside the try below: whatever beforeCall throws is not a proxy failure, so it propagates unchanged
      await beforeCall(room, request.kind);
      try {
        return await attempt(request, deadline);
      } catch (e) {
        const err = e instanceof ProxyError ? e : new ProxyError('Claude API request failed');
        if (!err.retryable || !retry) throw failed(err);
        const after = retryAfterMs(err.retryAfter, now());
        const delay = Math.max(after || 0, Math.random() * t.baseBackoffMs * 2 ** (n - 1));
        if (n >= 3 || (after !== null && after > t.maxRetryAfterMs) || deadline - (now() + delay) < t.minAttemptMs) {
          log.error('proxy.gave_up', fields(err), err);
          throw err;
        }
        log.warn('proxy.retry', fields(err), err);
        await wait(delay);
      }
    }
  }

  return {
    live: () => Boolean(apiKey),
    MODEL: model,
    draftCard: (args) => draftCard(callClaude, args),
    takeTurn: (room, seatId) => takeTurn(callClaude, room, seatId),
    mapAuthority: (room, terms) => mapAuthority(callClaude, room, terms),
  };
}

module.exports = { createProxy, parseJson, ProxyError }; // ProxyError lives in ./errors; re-exported for existing callers
