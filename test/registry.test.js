'use strict';
// server.json is Behalf's MCP Registry entry. It is published by hand (mcp-publisher), so these
// pin it to the code it describes: a drift here means the registry tells agents something false.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SERVER_INFO, SPEC_URL } = require('../lib/mcp');
const { loadConfig } = require('../lib/config');

const entry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server.json'), 'utf8'));

test('the registry entry carries the server version and title the MCP server reports', () => {
  assert.equal(SERVER_INFO.version, '0.3.0');
  assert.equal(entry.version, SERVER_INFO.version);
  assert.equal(entry.title, SERVER_INFO.title);
  assert.ok(entry.description.length <= 100, 'the registry caps the description at 100 characters');
});

test('the registry entry points at the default deploy and the published spec', () => {
  const publicUrl = loadConfig({}).publicUrl;
  assert.equal(entry.websiteUrl, publicUrl + '/');
  assert.deepEqual(entry.remotes.map((r) => [r.type, r.url]), [['streamable-http', publicUrl + '/mcp']]);
  assert.equal(entry._meta['io.modelcontextprotocol.registry/publisher-provided'].protocol.specification, SPEC_URL);
});

test('the agent key header is optional and secret, as the server treats it', () => {
  const [header] = entry.remotes[0].headers;
  assert.equal(header.name, 'Authorization');
  assert.equal(header.isRequired, false);
  assert.equal(header.isSecret, true);
});
