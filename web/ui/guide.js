/*
 * Style guide wiring for /ui. Classic script, loaded with defer after ui.js.
 * Everything is optional: a missing section or a missing UI helper is skipped, never thrown on.
 * All text is written with textContent. Nothing here assigns innerHTML.
 */
(function () {
  'use strict';

  // Obvious fake, so the guide never carries a real link or token.
  var FAKE_LINK = '/room/EXAMPLE?seat=B&t=EXAMPLE-TOKEN';

  // Remove blank lines at both ends and the indentation every line shares.
  function dedent(s) {
    var lines = s.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    var min = Infinity;
    lines.forEach(function (l) {
      if (!l.trim()) return;
      var n = /^[ \t]*/.exec(l)[0].length;
      if (n < min) min = n;
    });
    if (!isFinite(min)) return '';
    return lines.map(function (l) { return l.slice(min).replace(/\s+$/, ''); }).join('\n');
  }

  // Each [data-snippet="id"] example writes its own markup into the <code data-snippet-for="id"> that names it.
  function snippets() {
    var examples = document.querySelectorAll('[data-snippet]');
    Array.prototype.forEach.call(examples, function (ex) {
      var id = ex.getAttribute('data-snippet');
      var safe = window.CSS && CSS.escape ? CSS.escape(id) : id;
      var code = document.querySelector('[data-snippet-for="' + safe + '"]');
      if (code) code.textContent = dedent(ex.innerHTML);
    });
  }

  // The first :root rule of ui.css (the light tokens), found by walking the CSSOM through layer and media blocks.
  function findRoot(rules) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.selectorText === ':root') return r;
      if (r.cssRules) {
        var found = findRoot(r.cssRules);
        if (found) return found;
      }
    }
    return null;
  }

  // Colour tokens in declaration order. Anything that isn't a colour (sizes, fonts, the shadow) is left out.
  function colourTokens() {
    var names = [];
    try {
      var sheet = Array.prototype.find.call(document.styleSheets, function (s) {
        return /\/ui\/ui\.css$/.test(s.href || '');
      });
      var root = sheet && findRoot(sheet.cssRules);
      if (!root) return names;
      for (var j = 0; j < root.style.length; j++) {
        var name = root.style[j];
        if (name.indexOf('--') !== 0) continue;
        var value = root.style.getPropertyValue(name).trim();
        if (value && value !== 'transparent' && window.CSS && CSS.supports('color', value)) names.push(name);
      }
    } catch (e) { /* show nothing rather than throw */ }
    return names;
  }

  function swatches() {
    var grid = document.querySelector('[data-swatches]');
    if (!grid) return;
    var frag = document.createDocumentFragment();
    colourTokens().forEach(function (name) {
      var card = document.createElement('div');
      card.className = 'card card--raised';
      var box = document.createElement('div');
      box.className = 'guide-swatch';
      box.style.background = 'var(' + name + ')';
      var label = document.createElement('code');
      label.className = 'text-small';
      label.textContent = name;
      card.appendChild(box);
      card.appendChild(label);
      frag.appendChild(card);
    });
    grid.appendChild(frag);
  }

  function theme() {
    var radios = document.querySelectorAll('input[name="guide-theme"]');
    if (!radios.length || !window.UI) return;
    var current = window.UI.getTheme();
    Array.prototype.forEach.call(radios, function (r) {
      r.checked = r.value === current;
      r.addEventListener('change', function () {
        if (r.checked) window.UI.setTheme(r.value);
      });
    });
  }

  function toasts() {
    if (!window.UI) return;
    document.addEventListener('click', function (e) {
      var t = e.target;
      var el = t && t.closest ? t.closest('[data-toast]') : null;
      if (!el) return;
      window.UI.toast(el.getAttribute('data-message') || '', el.getAttribute('data-toast'));
    });
  }

  // The copy field's value is set as a property, never from markup.
  function copyField() {
    var input = document.getElementById('guide-seat-link');
    if (input) input.value = FAKE_LINK;
  }

  function init() {
    snippets();
    swatches();
    theme();
    toasts();
    copyField();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
