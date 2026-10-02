/*
 * Tiny Markdown renderer for the protocol spec. One classic script, no dependencies.
 *
 * A tokeniser: markup only ever comes from literal UI.html templates, never from the source text
 * (see the rules at the top of ui.js).
 *
 * render(src, UI) takes UI as a parameter and returns the SafeHtml UI.html produced.
 * Hand it to UI.render.
 *
 * Supports:
 *  - headings h1 to h3 (`#`, `##`, `###`)
 *  - fenced code blocks (content is text, no inline formatting)
 *  - pipe tables with a header row and, usually, a separator row (without one, every row after the first is body)
 *  - ordered (`1.`) and unordered (`-`) lists, with indented continuation lines (switching kind starts a new list)
 *  - paragraphs
 *  - inline `code`, **bold** and *em* (no nesting)
 * Links are not rendered: link syntax stays bare text.
 */
(function () {
  'use strict';

  var INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  var ITEM = /^(\d+\.|-) /;
  var BLOCK_START = /^(#|\||```|\d+\. |- )/;
  var HEADING = /^(#{1,3}) (.*)/;
  var ORDERED = /^\d+\./;
  var CONTINUATION = /^ {2,}\S/;
  var SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

  // Tokenise one line of text into segments, each mapped to a literal template.
  function inline(UI, text) {
    var out = [];
    var last = 0;
    var m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text)) !== null) {
      if (m.index > last) out.push(UI.html`${text.slice(last, m.index)}`);
      if (m[1] !== undefined) out.push(UI.html`<code>${m[1]}</code>`);
      else if (m[2] !== undefined) out.push(UI.html`<b>${m[2]}</b>`);
      else out.push(UI.html`<em>${m[3]}</em>`);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(UI.html`${text.slice(last)}`);
    return out;
  }

  function heading(UI, level, text) {
    var body = inline(UI, text);
    switch (level) {
      case 1: return UI.html`<h1>${body}</h1>`;
      case 2: return UI.html`<h2>${body}</h2>`;
      default: return UI.html`<h3>${body}</h3>`;
    }
  }

  function list(UI, ordered, items) {
    switch (ordered) {
      case true: return UI.html`<ol>${items}</ol>`;
      default: return UI.html`<ul>${items}</ul>`;
    }
  }

  function cells(row) {
    return row.split('|').slice(1, -1).map(function (c) { return c.trim(); });
  }

  function table(UI, rows) {
    var head = cells(rows[0]).map(function (c) { return UI.html`<th>${inline(UI, c)}</th>`; });
    var body = rows.slice(SEPARATOR.test(rows[1] || '') ? 2 : 1).map(function (r) {
      return UI.html`<tr>${cells(r).map(function (c) { return UI.html`<td>${inline(UI, c)}</td>`; })}</tr>`;
    });
    return UI.html`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function render(src, UI) {
    var out = [];
    var lines = String(src == null ? '' : src).split('\n');
    var i = 0;
    while (i < lines.length) {
      var l = lines[i];
      if (l.startsWith('```')) {
        var buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
        i++;
        out.push(UI.html`<pre><code>${buf.join('\n')}</code></pre>`);
        continue;
      }
      var h = HEADING.exec(l);
      if (h) { out.push(heading(UI, h[1].length, h[2])); i++; continue; }
      if (l.startsWith('|')) {
        var rows = [];
        while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
        out.push(table(UI, rows));
        continue;
      }
      if (ITEM.test(l)) {
        var ordered = ORDERED.test(l);
        var items = [];
        while (i < lines.length && ITEM.test(lines[i]) && ORDERED.test(lines[i]) === ordered) {
          var item = lines[i++].replace(ITEM, '');
          while (i < lines.length && CONTINUATION.test(lines[i])) item += ' ' + lines[i++].trim();
          items.push(UI.html`<li>${inline(UI, item)}</li>`);
        }
        out.push(list(UI, ordered, items));
        continue;
      }
      if (!l.trim()) { i++; continue; }
      var para = [lines[i++]]; // always consume one line, so a stray "#x" can't stall the loop
      while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) para.push(lines[i++]);
      out.push(UI.html`<p>${inline(UI, para.join(' '))}</p>`);
    }
    return UI.html`${out}`;
  }

  var Markdown = { render: render };

  if (typeof window !== 'undefined') window.Markdown = Markdown;
  else if (typeof module !== 'undefined' && module.exports) module.exports = Markdown;
})();
