'use strict';
// Errors shared across modules, so the domain can recognise one without requiring the proxy.

// A client-safe error: its code is the HTTP status and its message is shown to the caller.
// apiCode is an optional fixed machine code, sent as `code` next to the message so a client can pick its own sentence.
class ApiError extends Error {
  constructor(code, msg, apiCode) { super(msg); this.code = code; if (apiCode) this.apiCode = apiCode; }
}

// Saving has been failing for a while: one sentence and one machine code for every place that refuses because of it.
const savingUnavailable = () => new ApiError(503, 'Saving is unavailable right now. Try again in a minute.', 'saving_unavailable');

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

module.exports = { ApiError, ProxyError, BudgetError, AuthError, savingUnavailable };
