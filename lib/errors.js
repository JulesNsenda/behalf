'use strict';
// Errors shared across modules, so the domain can recognise one without requiring the proxy.

// A client-safe error: its code is the HTTP status and its message is shown to the caller.
class ApiError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

// An error built only from the HTTP status and an allowlisted Claude error type, never from the key, the request or the headers.
class ProxyError extends Error {
  constructor(message, httpStatus, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProxyError';
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

module.exports = { ApiError, ProxyError };
