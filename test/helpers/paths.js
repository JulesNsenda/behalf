'use strict';
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');
const UI_DIR = path.join(WEB, 'ui');

module.exports = {
  ROOT,
  WEB,
  UI_DIR,
  UI_JS: path.join(UI_DIR, 'ui.js'),
  THEME_JS: path.join(UI_DIR, 'theme.js'),
  UI_CSS: path.join(UI_DIR, 'ui.css'),
};
