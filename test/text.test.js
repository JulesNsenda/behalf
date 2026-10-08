'use strict';
// lib/text.js: the one cleaning helper for free text the server keeps (an agent key's name; the AI-access note later).
const { test } = require('node:test');
const assert = require('node:assert');
const { cleanText } = require('../lib/text');

test('cleanText: NFC, controls and format characters removed, line breaks become a space, white space collapses, ends trimmed', () => {
  assert.strictEqual(cleanText('  Claude Desktop  ', 40), 'Claude Desktop');
  assert.strictEqual(cleanText('Claude\u{202E} Desk\u{200B}top\u0007\u0000', 40), 'Claude Desktop', 'bidi override, zero-width space, controls');
  assert.strictEqual(cleanText('a\u{AD}b\u{FEFF}c\u{2066}d\u{2069}e', 40), 'abcde', 'soft hyphen, BOM, bidi isolates');
  assert.strictEqual(cleanText('a\nb\tc\rd', 40), 'a b c d', 'a newline, tab or return is a space, not nothing');
  assert.strictEqual(cleanText('a\u{2028}b\u{2029}c', 40), 'a b c', 'line and paragraph separators are spaces');
  assert.strictEqual(cleanText('a   b \u{A0}\u{A0} c', 40), 'a b c', 'runs of white space (a no-break space too) are one space');
  assert.strictEqual(cleanText('Cafe\u{301}', 40), 'Caf\u{E9}', 'NFC');
  assert.strictEqual(cleanText('\u{200B}\u{202E}', 40), '', 'all stripped is empty, which is for the caller to judge');
  assert.strictEqual(cleanText('', 40), '');
});

test('cleanText: the invisible fillers, private-use, unassigned and tag characters and the variation selectors are removed', () => {
  for (const c of ['\u{34F}', '\u{115F}', '\u{1160}', '\u{3164}', '\u{FFA0}', '\u{2800}', '\u{E000}', '\u{378}', '\u{E0041}', '\u{FE00}', '\u{FE0D}', '\u{E0100}', '\u{180B}']) {
    assert.strictEqual(cleanText('a' + c + 'b', 40), 'ab', 'U+' + c.codePointAt(0).toString(16));
  }
});

test('cleanText: ZWJ and ZWNJ, and the text and emoji presentation selectors, are kept', () => {
  const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
  assert.strictEqual(cleanText(family, 40), family, 'an emoji ZWJ sequence');
  const persian = '\u{645}\u{6CC}\u{200C}\u{62E}\u{648}\u{627}\u{647}\u{645}';
  assert.strictEqual(cleanText(persian, 40), persian, 'a Persian word with ZWNJ');
  assert.strictEqual(cleanText('\u{2764}\u{FE0F} ok', 40), '\u{2764}\u{FE0F} ok', 'emoji presentation');
  assert.strictEqual(cleanText('\u{2764}\u{FE0E} ok', 40), '\u{2764}\u{FE0E} ok', 'text presentation');
});

test('cleanText: no more than two combining marks stay on a character (Zalgo)', () => {
  const z = 'x' + '\u{301}'.repeat(30) + 'b\u{300}\u{301}\u{302}\u{303}';
  assert.strictEqual(cleanText(z, 40), 'x\u{301}\u{301}b\u{300}\u{301}');
  assert.strictEqual(cleanText('x\u{301}\u{302}', 40), 'x\u{301}\u{302}', 'two are fine');
  assert.strictEqual(cleanText('x\u{301}\u{301}\u{301} x\u{301}\u{301}\u{301}', 40), 'x\u{301}\u{301} x\u{301}\u{301}', 'the count restarts at every base character');
});

test('cleanText: a text with nothing visible is empty', () => {
  assert.strictEqual(cleanText('   \u{A0} \u{200D}\u{200C} ', 40), '');
  assert.strictEqual(cleanText('\u{301}\u{301}', 40), '', 'marks alone');
  assert.strictEqual(cleanText('\u{2800}\u{3164}\u{115F}', 40), '');
  assert.strictEqual(cleanText('\u{200D}\u{FE0F}', 40), '');
  assert.strictEqual(cleanText('...', 40), '...', 'punctuation is visible');
  assert.strictEqual(cleanText('\u{1F600}', 40), '\u{1F600}', 'a symbol is visible');
  assert.strictEqual(cleanText('7', 40), '7');
});

test('cleanText: the limit is in code points after cleaning', () => {
  const faces = '\u{1F600}'.repeat(40);
  assert.strictEqual(cleanText(faces, 40), faces, '40 code points are 80 UTF-16 units');
  assert.strictEqual(cleanText(faces + '\u{1F600}', 40), null);
  assert.strictEqual(cleanText('x'.repeat(40) + '\u{200B}', 40), 'x'.repeat(40), 'stripped characters do not count');
  assert.strictEqual(cleanText('x'.repeat(281), 280), null);
  assert.strictEqual(cleanText('x'.repeat(280), 280), 'x'.repeat(280));
});

test('cleanText: a lone surrogate or anything that is not text is refused', () => {
  for (const bad of ['\uD83D', 'ab\uDE00', '\uDE00\uD83D', undefined, null, 7, {}, [], true]) assert.strictEqual(cleanText(bad, 40), null, JSON.stringify(bad));
  assert.strictEqual(cleanText('\u{1F600}', 40), '\u{1F600}', 'a pair is fine');
});
