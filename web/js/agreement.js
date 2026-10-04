/*
 * Agreement page: DOM wiring only. All reader-facing wording comes from AgreementView (which reads
 * RoomView). The URL's ?seat= only chooses wording ("you" vs a name). It is never sent anywhere, and
 * no token is read or written: a ?t= left in the address by an old link is removed on load.
 */
(function () {
  'use strict';

  var AV = window.AgreementView;
  var RV = window.RoomView;
  var Links = window.Links;
  var T = AV.TITLES;
  var app = UI.byId('app');

  var params = new URLSearchParams(location.search);
  var seat = Links.seatFromSearch(location.search);
  // Keep ?seat= (wording only) and drop everything else, tokens above all.
  if (params.has('t')) {
    try { history.replaceState(null, '', location.pathname + Links.seatQuery(seat) + location.hash); } catch (e) { /* not fatal */ }
  }
  var roomId = Links.roomIdFromPath(location.pathname, '/brief/');

  function show(safe, title) {
    document.title = title + ' · Behalf';
    UI.render(app, safe);
  }

  // ---------- pieces ----------

  function outcomePanel(o) {
    if (!o) return UI.html``;
    return UI.html`<div class="outcome outcome--${o.tone === 'ok' ? 'ok' : 'warn'}"><div class="outcome__body"><h2 class="outcome__title">${o.text}</h2></div></div>`;
  }

  function pointsList(pts) {
    if (!pts.terms.length) return UI.html``;
    return UI.html`<ol class="points">${pts.terms.map(function (t) {
      var why = t.lines.map(function (l) { return UI.html`<p class="points__why">${l.text}</p>`; });
      var flag = t.flagged ? UI.html`<span class="pill pill--warn">${t.flagLabel}</span>` : false;
      return UI.html`<li class="points__item${t.flagged ? ' points__item--flagged' : ''}"><span class="points__num">${t.number}</span><div class="points__body"><p class="points__text">${t.term}</p>${flag}${why}</div></li>`;
    })}</ol>`;
  }

  function reviewLines(reviews) {
    return reviews.map(function (r) {
      return UI.html`<p class="text-caption">${r.sentence}</p>${r.reason ? UI.html`<p class="text-caption">${r.reason}</p>` : false}`;
    });
  }

  // A titled list of cards, or nothing when the list is empty. id is a literal that names the heading.
  function section(id, heading, items, renderItem) {
    if (!items.length) return UI.html``;
    return UI.html`<section class="stack stack--md" aria-labelledby="h-${id}">
      <h2 id="h-${id}">${heading}</h2>
      <ul class="stack stack--sm list-reset" role="list">${items.map(renderItem)}</ul>
    </section>`;
  }

  // One callout per guess the deal rests on, above the points.
  function reliedList(list) {
    if (!list.length) return UI.html``;
    return UI.html`<div class="stack stack--sm">${list.map(function (g) {
      return UI.callout('warn', UI.html`<p><strong>${T.relied}</strong></p><p>${g.text}</p><p class="text-caption">${g.note}</p>${reviewLines(g.reviews)}`);
    })}</div>`;
  }

  function guessesSection(list) {
    return section('guesses', T.guesses, list, function (g) {
      return UI.html`<li class="card stack stack--sm"><p>${g.text}</p><p class="text-caption">${g.note}</p>${reviewLines(g.reviews)}</li>`;
    });
  }

  function escalationsSection(list) {
    return section('checked', T.checked, list, function (e) {
      return UI.html`<li class="card stack stack--sm"><p><strong>${e.asked}</strong> ${e.question}</p><p><strong>${e.answered}</strong> ${e.answer}</p></li>`;
    });
  }

  // The room's stopped moves are callouts in a plain block, not a list.
  function flagsSection(list) {
    if (!list.length) return UI.html``;
    return UI.html`<section class="stack stack--md" aria-labelledby="h-stopped">
      <h2 id="h-stopped">${T.stopped}</h2>
      <div class="stack stack--sm">${list.map(function (f) {
        var detail = f.detail ? UI.html`<p class="text-caption">${f.detail}</p>` : false;
        return UI.callout('warn', UI.html`<p>${f.sentence}</p>${detail}`);
      })}</div>
    </section>`;
  }

  // The record line, with the rows behind it in a disclosure.
  function detailsSection(d) {
    return UI.html`<div class="stack stack--sm"><span class="status status--${d.recordOk ? 'ok' : 'danger'}">${d.recordLine}</span>
      <details class="disclosure"><summary>${T.details}</summary><div class="disclosure__body stack stack--sm">
        <ol class="record-list">${d.rows.map(function (r) {
          // The colon and space stay in the text, so a copied row reads "label: value" and never runs together.
          return UI.html`<li class="record-list__item"><span>${r.label}: </span><span class="${r.mono ? 'record-list__hash' : ''}">${r.value}</span></li>`;
        })}</ol>
      </div></details>
    </div>`;
  }

  function actions() {
    return UI.html`<div class="cluster no-print">
      <button class="btn btn--primary" type="button" id="copy-summary">${T.copy}</button>
      <button class="btn btn--secondary" type="button" id="print-page">${T.print}</button>
      <a class="btn btn--secondary" href="/start">${T.again}</a>
    </div>`;
  }

  function topicLine(R) {
    var t = AV.topic(R);
    return t ? UI.html`<p class="text-muted">${t}</p>` : false;
  }

  function wireActions(R) {
    var copy = UI.byId('copy-summary');
    if (copy) copy.addEventListener('click', function () { UI.copy(AV.summaryText(R, seat)); });
    var print = UI.byId('print-page');
    if (print) print.addEventListener('click', function () { window.print(); });
  }

  // Back to the conversation keeps ?seat= when the viewer has a valid seat, and never a token: the room
  // page finds this tab's saved token for that seat. Only used once the room id is known to be valid.
  function backPath() { return Links.roomPath(roomId, seat); }

  // "Back to the conversation" lives in the header, once the room id is known to be valid.
  function headerLink() {
    UI.render(UI.byId('header-end'), UI.html`<a class="btn btn--link" href="${UI.url(backPath())}">${T.back}</a>`);
  }

  // ---------- states ----------

  function renderAgreed(R) {
    var h = AV.heading(R, seat);
    var pts = AV.points(R, seat);
    var note = pts.note ? UI.callout('info', UI.html`<p>${pts.note}</p>`, { icon: 'lock' }) : false;
    show(UI.html`<div class="stack stack--xl">
      <div class="stack stack--sm"><h1 tabindex="-1">${h}</h1><p class="text-muted">${AV.subtitle(R, seat)}</p></div>
      ${outcomePanel(AV.outcome(R))}
      ${reliedList(AV.reliedGuesses(R, seat))}
      ${pointsList(pts)}
      ${note}
      ${guessesSection(AV.guessesOnRecord(R, seat))}
      ${escalationsSection(AV.escalations(R, seat))}
      ${flagsSection(AV.flags(R, seat))}
      ${actions()}
      ${detailsSection(AV.detailRows(R, seat))}
    </div>`, h);
    wireActions(R);
  }

  // The heading says "No deal reached", so there is no second outcome heading under it.
  function renderNoDeal(R) {
    var h = AV.heading(R, seat);
    var nd = AV.noDeal(R, seat);
    var esc = AV.escalations(R, seat);
    var fl = AV.flags(R, seat);
    // With nothing to list the page is just the heading, the actions and the record, so it keeps a tight gap.
    var bare = !nd.claimed.length && !nd.stuck.length && !esc.length && !fl.length;
    show(UI.html`<div class="stack ${bare ? 'stack--md' : 'stack--xl'}">
      <div class="stack stack--sm"><h1 tabindex="-1">${h}</h1>${topicLine(R)}<p class="text-muted">${AV.noDealReason(R)}</p></div>
      ${section('claimed', T.claimed, nd.claimed, function (c) {
        var mark = c.pill ? UI.html`<span class="pill pill--warn">${c.pill}</span>` : false;
        return UI.html`<li class="card stack stack--sm"><p>${c.text}</p><p class="text-caption">${c.by}</p>${mark}</li>`;
      })}
      ${section('stuck', T.stuck, nd.stuck, function (c) {
        return UI.html`<li class="card stack stack--sm"><p>${c.text}</p><p class="text-caption">${c.by}</p>${reviewLines(c.reviews)}</li>`;
      })}
      ${escalationsSection(esc)}
      ${flagsSection(fl)}
      ${actions()}
      ${detailsSection(AV.detailRows(R, seat))}
    </div>`, h);
    wireActions(R);
  }

  function renderNotYet(R) {
    var h = AV.heading(R, seat);
    show(UI.html`<div class="stack stack--md">
      <h1 tabindex="-1">${h}</h1>
      ${topicLine(R)}
      <div class="cluster no-print"><a class="btn btn--primary" href="${UI.url(backPath())}">${T.back}</a></div>
    </div>`, h);
  }

  function renderNotFound() {
    var h = AV.heading(null, seat);
    show(UI.html`<div class="stack stack--md">
      <h1 tabindex="-1">${h}</h1>
      <div class="cluster"><a class="btn btn--primary" href="/start">${T.start}</a></div>
    </div>`, h);
  }

  function render(R) {
    switch (AV.state(R)) {
      case 'agreed': return renderAgreed(R);
      case 'no-deal': return renderNoDeal(R);
      case 'not-yet': return renderNotYet(R);
      default: return renderNotFound();
    }
  }

  // ---------- load ----------

  // Only a 404 means the room isn't there. Anything else is a failure to load, so it can be retried.
  function renderLoadError(status) {
    show(UI.html`<div class="stack stack--md">
      ${UI.alertBox(RV.errorMessage('load', status), 'danger')}
      <div class="cluster"><button class="btn btn--primary" type="button" id="load-retry">${RV.pageText(null).tryAgain}</button></div>
    </div>`, 'Room');
    UI.byId('load-retry').addEventListener('click', load);
  }

  // A room view is an object with an id. A body that isn't JSON arrives as {}, which is not a room.
  function isRoom(R) { return Boolean(R) && typeof R === 'object' && !Array.isArray(R) && typeof R.id === 'string'; }

  function load() {
    UI.request('GET', '/api/rooms/' + encodeURIComponent(roomId)).then(function (res) {
      if (res.status === 404) renderNotFound();
      else if (!res.ok) renderLoadError(res.status);
      else if (isRoom(res.data)) render(res.data);
      else renderLoadError(500);
    });
  }

  if (roomId === null) {
    renderNotFound();
  } else {
    headerLink();
    load();
  }
})();
