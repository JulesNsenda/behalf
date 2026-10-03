'use strict';
// Errors shared across modules, so the domain can recognise one without requiring the proxy.

// A client-safe error: its code is the HTTP status and its message is shown to the caller.
// apiCode is an optional fixed machine code, sent as `code` next to the message so a client can pick its own sentence.
class ApiError extends Error {
  constructor(code, msg, apiCode) { super(msg); this.code = code; if (apiCode) this.apiCode = apiCode; }
}

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

module.exports = { ApiError, ProxyError, BudgetError };
