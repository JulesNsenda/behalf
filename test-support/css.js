'use strict';
// A small brace-matching CSS parser for the stylesheet tests.

// Comments become spaces of the same length, so an index into the result is an index into the source.
function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)); }

// Index of the closing quote / paren for a string or parenthesised group starting at j.
function skip(src, j, to) {
  const c = src[j];
  if (c === '"' || c === "'") {
    let k = j + 1;
    while (k < to && src[k] !== c) k += src[k] === '\\' ? 2 : 1;
    return k;
  }
  if (c === '(') {
    let depth = 1;
    let k = j + 1;
    while (k < to && depth) {
      if (src[k] === '"' || src[k] === "'") k = skip(src, k, to);
      else if (src[k] === '(') depth++;
      else if (src[k] === ')') depth--;
      k++;
    }
    return k - 1;
  }
  return j;
}

// Returns nodes { prelude, pstart, open, close, children }. open/close bound the block body;
// pstart is where the prelude starts. Strings and parentheses are skipped so braces or
// semicolons inside them don't confuse it.
function parseBlocks(src, from, to) {
  const nodes = [];
  let i = from;
  let start = from;
  while (i < to) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '(') { i = skip(src, i, to) + 1; continue; }
    if (c === ';') { start = i + 1; i++; continue; }
    if (c === '{') {
      const prelude = src.slice(start, i).trim();
      let depth = 1;
      let k = i + 1;
      while (k < to && depth) {
        if (src[k] === '"' || src[k] === "'" || src[k] === '(') { k = skip(src, k, to) + 1; continue; }
        if (src[k] === '{') depth++;
        else if (src[k] === '}') depth--;
        k++;
      }
      const close = k - 1;
      nodes.push({ prelude, pstart: start, open: i + 1, close, children: parseBlocks(src, i + 1, close) });
      i = k;
      start = i;
      continue;
    }
    i++;
  }
  return nodes;
}

module.exports = { stripComments, parseBlocks };
