'use strict';
// One line per call on stderr: `level=error event="store.save_failed" room="abc" errorClass="TypeError"`.
// Rules, so a log line can never carry user or model data:
//  - only allowlisted fields are written; any other key is dropped silently;
//  - every value goes through JSON.stringify (plus U+0085/U+2028/U+2029 escaped), so no value can start a fake line;
//  - never pass e.message (V8 messages can echo model output). Pass the error as the third argument instead:
//    log.error(event, { room }, err). The logger is the only source of errorClass, code and stack, which it derives
//    from the error: the class, an optional error code, and well-formed stack frames only. It fails closed, and any
//    errorClass, code or stack in the caller's fields is dropped;
//  - never log URLs, query strings, tool arguments, cards, drafts, answers, model output or tokens.
// The listen line is not logged here: it stays a console.log on stdout.
const ALLOWED = ['room', 'seat', 'status', 'httpStatus', 'errorClass', 'code', 'durationMs', 'stack', 'reason', 'kind'];
const FROM_ERROR = ['errorClass', 'code', 'stack'];
const REASONS = ['ttl', 'capacity']; // the only values `reason` may carry (why a room was evicted)
// The only values `kind` may carry: a store record kind (lib/store-core.js's table, plus the meta row), never an id.
const KINDS = [...Object.keys(require('./store-core').KIND), 'meta'];

// A full V8 frame: `at fn (file:1:2)`, `at async fn (file:1:2)`, `at new Foo (file:1:2)`, `at file:1:2`,
// `at Array.map (<anonymous>)`, `at Object.<anonymous> (file:1:2)`, `at node:internal/x:1:2`. The function name is an
// identifier-ish charset, so a computed name with parentheses is not accepted.
const FRAME = /^\s+at (?:async )?(?:[\w$.<>[\] ]{1,120} \()?(?:[^()]+:\d+:\d+|<anonymous>)\)?$/;
const CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

// V8 builds the stack as `${name}: ${message}` (just the name when the message is empty), then the frames. Only trust
// it when that header matches exactly, then keep the contiguous run of frames at the very end.
function safeFrames(e) {
  const header = (e.message ? `${e.name}: ${e.message}` : String(e.name)).split('\n');
  const lines = e.stack.split('\n');
  if (lines.length <= header.length || header.some((h, i) => lines[i] !== h)) return '';
  const frames = [];
  for (let i = lines.length - 1; i >= header.length; i--) {
    const l = lines[i].replace(/ \[as [^\]]*\]/g, '');
    if (!FRAME.test(l)) break;
    frames.unshift(l);
  }
  return frames.slice(0, 10).join('\n');
}

function errorFields(e) {
  try {
    const name = e && typeof e.name === 'string' && /^[A-Za-z0-9_$.]{1,64}$/.test(e.name) ? e.name : 'Error';
    const out = { errorClass: name };
    const rawCode = e && (e.code || (e.cause && e.cause.code));
    if (typeof rawCode === 'string' && CODE.test(rawCode)) out.code = rawCode;
    if (e && typeof e.stack === 'string' && typeof e.message === 'string' && typeof e.name === 'string') {
      const stack = safeFrames(e);
      if (stack) out.stack = stack;
    }
    return out;
  } catch (err) {
    return { errorClass: 'Error' };
  }
}

// After JSON.stringify, everything outside printable ASCII becomes \uXXXX: no control, separator or bidi character
// (U+0085, U+2028, U+202E, ...) can reach a log viewer raw.
const escape = (s) => s.split('').map((c) => {
  const n = c.charCodeAt(0);
  return n >= 0x20 && n <= 0x7e ? c : String.fromCharCode(92) + 'u' + n.toString(16).padStart(4, '0');
}).join('');

function createLog({ stream = process.stderr } = {}) {
  const write = (level, event, fields, err) => {
    try {
      const own = {};
      for (const k of ALLOWED) if (!FROM_ERROR.includes(k) && fields && Object.prototype.hasOwnProperty.call(fields, k)) own[k] = fields[k];
      if (own.reason !== undefined && !REASONS.includes(own.reason)) delete own.reason;
      if (own.kind !== undefined && !KINDS.includes(own.kind)) delete own.kind;
      const all = err === undefined ? own : Object.assign(own, errorFields(err));
      let line = `level=${level} event=${JSON.stringify(String(event))}`;
      for (const k of ALLOWED) {
        if (all[k] === undefined) continue;
        const v = all[k];
        line += ` ${k}=${JSON.stringify(typeof v === 'number' || typeof v === 'boolean' ? v : String(v))}`;
      }
      stream.write(escape(line) + '\n');
    } catch (e) { /* logging must never throw */ }
  };
  return { info: (e, f, x) => write('info', e, f, x), warn: (e, f, x) => write('warn', e, f, x), error: (e, f, x) => write('error', e, f, x) };
}

module.exports = { createLog, errorFields, ALLOWED };
