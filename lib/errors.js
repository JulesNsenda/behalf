'use strict';
// Errors shared across modules, so the domain can recognise one without requiring the proxy.

// An error built only from the HTTP status and an allowlisted Claude error type, never from the key, the request or the headers.
class ProxyError extends Error {
  constructor(message, httpStatus, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProxyError';
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

module.exports = { ProxyError };
