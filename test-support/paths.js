'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const UI_DIR = path.join(WEB, 'ui');

// A repo file as text, e.g. readRepo('lib/pxp.js').
function readRepo(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }

// index.js plus every lib/*.js in name order, so code moving between files never touches source scans.
function serverSource() {
  const libs = fs.readdirSync(path.join(ROOT, 'lib')).filter(n => n.endsWith('.js')).sort();
  return [readRepo('index.js'), ...libs.map(n => readRepo('lib/' + n))].join('\n');
}

module.exports = {
  ROOT,
  WEB,
  UI_DIR,
  UI_JS: path.join(UI_DIR, 'ui.js'),
  THEME_JS: path.join(UI_DIR, 'theme.js'),
  UI_CSS: path.join(UI_DIR, 'ui.css'),
  readRepo,
  serverSource,
};
