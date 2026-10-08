'use strict';
// Free text a person types that the server keeps (an agent key's name, an AI-access request's note), cleaned in one place.
// cleanText(value, max) -> the cleaned string, or null when it cannot be kept: not a string, a lone surrogate, or more than `max`
// code points after cleaning. The result can be '' (nothing visible is left): whether that is allowed is for the caller. Cleaning is,
// in order:
//  - NFC;
//  - tab, line feed, carriage return and the line and paragraph separators become a space;
//  - every other control (Cc), format (Cf: the bidi marks, the tag characters), private-use (Co) and unassigned (Cn) character is
//    removed, and so are the invisible fillers (U+034F, the Hangul and Halfwidth fillers, U+3164, U+2800) and the variation
//    selectors. Kept on purpose: U+200C and U+200D (a Persian word and an emoji sequence need them) and U+FE0E and U+FE0F
//    (text and emoji presentation);
//  - at most MARKS combining marks in a row (Zalgo text), then runs of white space become one space and the ends are trimmed;
//  - a text with no letter, number, punctuation or symbol left is empty.
// Nothing here echoes or logs the text; a caller's refusal is a fixed sentence.
const MARKS = 2;
const SPACES = /[\t\n\r\u{2028}\u{2029}]/gu;
const STRIP = /(?![\u{200C}\u{200D}])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u{34F}\u{115F}\u{1160}\u{180B}-\u{180D}\u{180F}\u{3164}\u{FFA0}\u{2800}\u{FE00}-\u{FE0D}\u{E0100}-\u{E01EF}]/gu;
const MARK = /^\p{M}$/u;
const WHITE = /\s+/gu;
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

// Marks past the second in a run are dropped; a run restarts at every character that is not a mark.
function capMarks(s) {
  let out = '';
  let run = 0;
  for (const ch of s) {
    run = MARK.test(ch) ? run + 1 : 0;
    if (run <= MARKS) out += ch;
  }
  return out;
}

function cleanText(value, max) {
  if (typeof value !== 'string' || !value.isWellFormed()) return null;
  const cleaned = capMarks(value.normalize('NFC').replace(SPACES, ' ').replace(STRIP, '')).replace(WHITE, ' ').trim();
  if ([...cleaned].length > max) return null;
  return VISIBLE.test(cleaned) ? cleaned : '';
}

const LOGIN = /^[A-Za-z0-9-]{1,39}$/; // a GitHub user name

module.exports = { cleanText, LOGIN };
