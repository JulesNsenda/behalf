'use strict';
// The plain-writing guidance both the built-in proxy prompt and the MCP instructions carry.
// Each puts it under its own section heading; the wording lives here once.

// Words a person must never read in anything the AIs write. Every prompt that asks for
// reader-facing text interpolates this, so the list lives here once.
const BANNED_TERMS = ['principal', 'proxy', 'escalate', 'intent card', 'card'];
const BANNED_LIST = BANNED_TERMS.slice(0, -1).map(t => `"${t}"`).join(', ') + ' or "' + BANNED_TERMS[BANNED_TERMS.length - 1] + '"';

const PLAIN_WRITING = `Both people read what you write in "message", "claims[].text", "reviews[].reason", "escalation.question", "escalation.reason" and proposal terms. Write short, plain sentences there. Never use claim IDs (like "B2.2"), card field names (like "must_never" or "escalate_when"), or the words ${BANNED_LIST}. Refer to both people by first name (for example "Lerato"). The people's own domain vocabulary is fine and expected, especially in proposal terms, which are agreed exactly as written.`;

module.exports = { PLAIN_WRITING, BANNED_TERMS, BANNED_LIST };
