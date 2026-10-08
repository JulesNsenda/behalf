'use strict';
// Errors shared across modules, so the domain can recognise one without requiring the proxy.

// A client-safe error: its code is the HTTP status and its message is shown to the caller.
// apiCode is an optional fixed machine code, sent as `code` next to the message so a client can pick its own sentence.
class ApiError extends Error {
  constructor(code, msg, apiCode) { super(msg); this.code = code; if (apiCode) this.apiCode = apiCode; }
}

// Saving has been failing for a while: one sentence and one machine code for every place that refuses because of it.
const savingUnavailable = () => new ApiError(503, 'Saving is unavailable right now. Try again in a minute.', 'saving_unavailable');

// Opening a live room needs a signed-in user: one sentence and one machine code for the web guard and the domain alike.
const SIGNIN_REQUIRED = 'signin_required'; // the machine code of every 401 that asks for a sign-in
const signinRequired = () => new ApiError(401, 'Sign in to open a live room.', SIGNIN_REQUIRED);

// What MCP create_room says when sign-in is required and it has no usable agent key. Fixed sentences: never the key or the header.
// The page is named by its absolute URL, because an external agent cannot resolve a relative path. keyPageUrl builds that absolute
// URL for these sentences and the MCP sign-in text (lib/mcp.js); the route itself is in lib/http.js.
const keyPageUrl = (publicUrl) => `${publicUrl}/key`;
const AGENT_KEY_MISSING = (url) => `create_room needs an agent key: your principal signs in at ${keyPageUrl(url)}, creates one, and adds it to your MCP client as an Authorization header.`;
const AGENT_KEY_REJECTED = (url) => `That agent key no longer works: your principal signs in at ${keyPageUrl(url)} and creates a new one, then updates the Authorization header in your MCP client.`;

// `rejected`: an Authorization header was sent but its key does not work (unknown, revoked, idle, blocked), against none sent at all.
const agentKeyRequired = (rejected, publicUrl) => new ApiError(401, rejected ? AGENT_KEY_REJECTED(publicUrl) : AGENT_KEY_MISSING(publicUrl), SIGNIN_REQUIRED);

// An error built only from the HTTP status and an allowlisted Claude error type, never from the key, the request or the headers.
class ProxyError extends Error {
  constructor(message, httpStatus, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProxyError';
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

// The per-room spend cap was reached (D12). Client-safe by construction, like every ApiError.
class BudgetError extends ApiError {
  constructor() { super(429, 'This room has used up its AI allowance. Start a new room to keep going.'); this.name = 'BudgetError'; }
}

// A sign-in failed. The code is one of AUTH_STATE, AUTH_EXCHANGE, AUTH_PROFILE, AUTH_BLOCKED, AUTH_RATE and the message is fixed:
// never text from GitHub, the OAuth code, the state or a token. The logger reads the code from the error.
class AuthError extends Error {
  constructor(code) { super('Sign-in failed'); this.name = 'AuthError'; this.code = code; }
}

module.exports = { ApiError, ProxyError, BudgetError, AuthError, savingUnavailable, signinRequired, agentKeyRequired, keyPageUrl, SIGNIN_REQUIRED };
