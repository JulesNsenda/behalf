'use strict';
// What the server refuses each web action with, and a census that stops a new refusal code shipping without a sentence.
//  - EXPECTED is written by hand: for each web action, the coded refusals (status, code) the page must have a sentence of its own for.
//    (Refusals with no code are worded by status, and held to the server by the status scan in test/room-view.test.js.) The route ->
//    action names are the page's, so they live here and the server does not know them.
//  - codesInServer() is the census: every machine code the server source can send, found three ways: a quoted code as the third
//    argument of ApiError( anywhere in lib/ (and index.js), the string constants lib/errors.js exports, and what each factory
//    lib/errors.js exports makes when it is called. A quota code is also written in a tuple, not as an argument, so any 'xxx_limit'
//    literal counts.
//  - unclassifiedCodes() is the codes the census found that neither EXPECTED nor MCP_ONLY accounts for. A test requires none.
const errors = require('../lib/errors');
const { serverSource } = require('./paths');

const EXPECTED = {
  create: [[401, 'signin_required'], [403, 'origin'], [415, 'content_type'], [429, 'user_limit'], [429, 'ip_limit'], [429, 'daily_limit'], [503, 'saving_unavailable']],
  draft: [[503, 'shutting_down']],
  logout: [[403, 'origin'], [415, 'content_type'], [503, 'saving_unavailable']],
  keyCreate: [[401, 'signin_required'], [403, 'origin'], [415, 'content_type'], [429, 'rate_limited'], [503, 'saving_unavailable']],
  keyRevoke: [[401, 'signin_required'], [403, 'origin'], [415, 'content_type'], [503, 'saving_unavailable']],
};

// Codes only an MCP client can receive, with no web action. (agentKeyRequired answers create_room with signin_required, which the web
// create also has, so it needs no entry.)
const MCP_ONLY = [];

const isClass = (fn) => /^class\b/.test(Function.prototype.toString.call(fn));

function codesInServer() {
  const found = new Set();
  const src = serverSource();
  for (const line of src.split('\n')) {
    if (/^\s*\/\//.test(line)) continue;
    // ApiError(status, message, 'code'): the message is a string or a name
    for (const m of line.matchAll(/ApiError\(\d{3},\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z_$.]+),\s*'([a-z][a-z_]*)'\s*\)/g)) found.add(m[1]);
    // the quota's code ends a tuple: [usage.byUser, owner.id, PER_USER_DAILY, 'user_limit']
    for (const m of line.matchAll(/,\s*'([a-z]+_limit)'\]/g)) found.add(m[1]);
  }
  for (const value of Object.values(errors)) {
    if (typeof value === 'string') found.add(value);
    else if (typeof value === 'function' && !isClass(value)) for (const e of [value(false), value(true)]) if (e.apiCode) found.add(e.apiCode);
  }
  return found;
}

function unclassifiedCodes() {
  const known = new Set([...Object.values(EXPECTED).flatMap((pairs) => pairs.map(([, code]) => code)), ...MCP_ONLY]);
  return [...codesInServer()].filter((code) => !known.has(code)).sort();
}

module.exports = { EXPECTED, MCP_ONLY, codesInServer, unclassifiedCodes };
