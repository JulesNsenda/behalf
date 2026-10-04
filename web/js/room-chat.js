/*
 * Room page conversation step: the chat, thinking tail, decision card, outcome, instructions and record
 * details, registered as A.steps.conversation. It uses RoomApp, A.ui (room-kit.js), UI, RoomView and
 * Links. The scaffold is rendered once; each update only patches the regions whose input changed.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var RV = window.RoomView;
  var Links = window.Links;
  var html = UI.html;
  var A = window.RoomApp;
  var ui = A.ui;

  A.steps.conversation = (function () {
    var fingerprints = {}; // seq -> fingerprint of what is on screen
    var nodes = new Map(); // seq -> element
    var rows = {};         // ledger n -> the row's text element
    var seen = {};         // region name -> the signature last rendered into it (changed() only)
    var started = false;   // the first update has run
    var rowCount = 0;      // ledger rows already written
    var touched = false;   // a region was written during this update
    var replayed = false;
    var observer = null;
    var shownDecision = null;  // key of the last decision card shown (entrance motion runs only for a new one)
    var shownOutcome = null;   // outcome text last shown (same rule)

    // True when `sig` is not what the region last rendered, and remembers it.
    function changed(name, sig) {
      if (name in seen && seen[name] === sig) return false;
      seen[name] = sig;
      touched = true;
      return true;
    }

    function view() {
      var text = A.text;
      return html`<div class="stack stack--md">
        <div class="stack stack--sm">
          ${ui.titleBlock(ui.topic())}
          <div><span class="pill pill--warn" id="guess-pill" hidden></span></div>
        </div>
        <div id="connect-slot" class="stack stack--md" hidden></div>
        <div class="chat" id="chat" role="region" aria-label="${text.chatLabel}"></div>
        <div class="chat" id="chat-tail" hidden></div>
        <div id="decision-slot" hidden></div>
        <div id="outcome-slot" class="stack stack--md" hidden></div>
        <div id="details-slot" class="stack stack--sm" hidden></div>
      </div>`;
    }

    function wire() {
      fingerprints = {};
      nodes = new Map();
      rows = {};
      seen = {};
      started = false;
      rowCount = 0;
      shownDecision = null;
      shownOutcome = null;
      stopWatching();
      var slot = UI.byId('details-slot');
      var text = A.text;
      UI.render(slot, html`<details class="disclosure" id="details-instructions" hidden>
          <summary>${text.instructionsSummary}</summary>
          <div class="disclosure__body stack stack--sm" id="details-instructions-body"></div>
        </details>
        ${recordBlock()}`);
      slot.hidden = false;
    }

    function unmount() { stopWatching(); }

    // ---- chat ----

    function claimBlock(c) {
      var pillClass = c.origin === 'stated' ? 'pill pill--party ' + ui.partyClass(c.seat) : c.origin === 'sourced' ? 'pill' : 'pill pill--warn';
      var text = c.unconfirmed ? html`<p><span class="mark-unconfirmed">${c.text}</span></p>` : html`<p>${c.text}</p>`;
      // The row holds the pill, the room's fixed note and, when every review accepted, those reviews.
      // Any warning among the reviews puts all of them below, in order, as full lines.
      var note = c.note ? html`<span>${c.note}</span>` : false;
      var inRow = c.allAccepted ? c.reviews.map(function (n) { return html`<span>${RV.reviewLine(n)}</span>`; }) : [];
      var meta = html`<div class="claim-meta"><span class="${pillClass}">${c.pill}</span>${note}${inRow}</div>`;
      var detail = c.detailQuote ? html`<span class="bubble__note">${c.detailQuote}</span>` : false;
      var lines = c.allAccepted ? [] : c.reviews.map(function (n) { return html`<span class="bubble__note">${RV.reviewLine(n)}</span>`; });
      return html`${text}${meta}${detail}${lines}`;
    }

    function proposalBlock(mv) {
      var p = mv.proposal;
      var warn = p.note ? html`<span class="pill pill--warn">${p.note}</span>` : false;
      return html`<div class="proposal proposal--party ${ui.partyClass(mv.seat)}">
        <span class="proposal__label">${RV.proposes(mv.speaker)}</span>
        <ul class="proposal__list">${p.terms.map(function (t) { return html`<li>${t}</li>`; })}</ul>
        ${warn}
      </div>`;
    }

    // The room's own sentence, then what the AI wrote, attributed and quoted, never inside the sentence.
    function flagBlock(f) {
      var quote = f.quote ? html`<p class="text-caption">${f.quote}</p>` : false;
      return UI.callout('warn', html`<p>${f.line}</p>${quote}`);
    }

    // One message and the events that belong to it, in a nested .chat so bubbles keep their alignment.
    function buildGroup(env, enter) {
      var mv = RV.messageView(A.room, env);
      var group = document.createElement('div');
      group.className = 'chat';
      UI.render(group, html`<div class="bubble ${mv.end ? 'bubble--end' : ''} ${ui.partyClass(mv.seat)} ${enter ? 'bubble--enter' : ''}" role="group" aria-label="${mv.ariaLabel}">
        <span class="bubble__name">${mv.speaker}</span>
        <div class="bubble__body">
          ${mv.message ? html`<p>${mv.message}</p>` : false}
          ${mv.claims.map(claimBlock)}
          ${mv.proposal ? proposalBlock(mv) : false}
        </div>
      </div>
      ${mv.acceptEvent ? html`<p class="chat__event">${mv.acceptEvent}</p>` : false}
      ${mv.escalationEvents.map(function (ev) { return html`<p class="chat__event" data-kind="${ev.kind}" tabindex="-1">${ev.lead} ${ev.quote}</p>`; })}
      ${mv.flags.map(flagBlock)}`);
      return group;
    }

    // Applies RV.planChat to the DOM. Returns the plan and the message whose answer the person just gave.
    function reconcileChat(room, first) {
      var chat = UI.byId('chat');
      var plan = RV.planChat(fingerprints, room);
      var bySeq = {};
      (room.envelopes || []).forEach(function (env) { bySeq[env.seq] = env; });
      var focus = A.pendingFocus;
      var answered = null;
      plan.remove.forEach(function (seq) {
        chat.removeChild(nodes.get(seq));
        nodes.delete(seq);
      });
      plan.replace.forEach(function (seq) {
        var node = buildGroup(bySeq[seq], false);
        chat.replaceChild(node, nodes.get(seq));
        nodes.set(seq, node);
        if (focus && focus.kind === 'answer' && focus.seq === seq) answered = node;
      });
      plan.add.forEach(function (seq) {
        var node = buildGroup(bySeq[seq], !first);
        chat.appendChild(node);
        nodes.set(seq, node);
      });
      if (plan.remove.length || plan.replace.length || plan.add.length) touched = true;
      fingerprints = plan.fps; // the fingerprints planChat already made: what is on screen now
      return { plan: plan, answered: answered };
    }

    // Thinking dots, or the line saying who the room is waiting for.
    function renderTail(room) {
      var tail = RV.tail(room);
      if (!changed('tail', JSON.stringify([tail, room.thinking]))) return;
      var el = UI.byId('chat-tail');
      if (tail && tail.kind === 'thinking') {
        var seat = room.thinking;
        ui.fill(el, html`<div class="thinking ${RV.bubbleEnd(room, seat) ? 'thinking--end' : ''} ${ui.partyClass(seat)}">
          <span class="thinking__dot"></span><span class="thinking__dot"></span><span class="thinking__dot"></span>
          <span class="text-caption">${tail.label}</span></div>`);
      } else if (tail) {
        ui.fill(el, html`<p class="chat__event">${tail.label}</p>`);
      } else {
        ui.fill(el, null);
      }
    }

    function renderPill(room) {
      var pill = RV.guessPill(room) || '';
      if (!changed('pill', pill)) return;
      var el = UI.byId('guess-pill');
      el.textContent = pill;
      el.hidden = !pill;
    }

    function renderConnectIfChanged() {
      var want = Boolean(A.step.connectCallout);
      if (!changed('connect', JSON.stringify([want, RV.recordKey(A.room)]))) return;
      var slot = UI.byId('connect-slot');
      if (want) {
        var callout = A.text.connectCallout;
        ui.renderConnectSlot(slot, UI.callout('warn', html`<p class="callout__title">${callout.title}</p><p>${callout.text}</p>`));
      } else {
        ui.fill(slot, null);
      }
    }

    // ---- decision ----

    function decisionCard(dv, enter) {
      var body;
      if (dv.options) {
        body = html`<div class="cluster">${dv.options.map(function (o, i) {
          return html`<button class="btn ${i === 0 ? 'btn--primary' : 'btn--secondary'}" type="button" data-index="${i}">${o.label}</button>`;
        })}</div>`;
      } else {
        body = html`<div class="field">
            <label class="field__label" for="decision-answer">${dv.textarea.label}</label>
            <span class="field__hint" id="decision-answer-hint">${dv.textarea.hint}</span>
            <textarea class="textarea" id="decision-answer" aria-describedby="decision-answer-hint"></textarea>
          </div>
          <div class="cluster"><button class="btn btn--primary" type="button" id="decision-send">${A.text.answerButton}</button></div>`;
      }
      return html`<section class="decision decision--party ${ui.partyClass(dv.seat)}${enter ? ' decision--enter' : ''}" id="decision-card" aria-labelledby="decision-title" aria-describedby="decision-question">
        <h2 class="decision__title" id="decision-title" tabindex="-1">${dv.heading}</h2>
        <p class="decision__question" id="decision-question">${dv.quote}</p>
        ${body}
        <p class="decision__note">${dv.visibilityNote}</p>
        <div id="decision-error" hidden></div>
      </section>`;
    }

    // dv is the decision as it was rendered, so the answer goes to the question the person read.
    function sendAnswer(dv, body, busy, disable) {
      var room = A.room;
      if (!room || !room.pending || room.pending.seq !== dv.seq) { ui.showError('decision-error', RV.errorMessage('answer', 409)); return; }
      if (typeof body.answer === 'string' && A.cred.containsToken(body.answer)) {
        ui.showError('decision-error', A.text.answerHasToken);
        return;
      }
      ui.act({
        busy: busy,
        disable: disable,
        error: 'decision-error',
        kind: 'answer',
        focus: { kind: 'answer', seq: dv.seq },
        send: function () { return A.post(dv.seat, 'answer', body); }
      });
    }

    function wireDecision(dv) {
      var card = UI.byId('decision-card');
      var buttons = Array.prototype.slice.call(card.querySelectorAll('[data-index]'));
      buttons.forEach(function (b) {
        b.addEventListener('click', function () {
          sendAnswer(dv, { option: dv.options[Number(b.getAttribute('data-index'))].key }, b, buttons.filter(function (o) { return o !== b; }));
        });
      });
      var send = UI.byId('decision-send');
      if (send) {
        send.addEventListener('click', function () {
          var answer = UI.byId('decision-answer').value.trim();
          if (!answer) { ui.showError('decision-error', RV.errorMessage('answer', 400)); return; }
          sendAnswer(dv, { answer: answer }, [send], UI.byId('decision-answer'));
        });
      }
    }

    // The dock shows while the send controls are off screen. The observer is made on first use and reused.
    function watchDecision(card) {
      stopWatching();
      var controls = card && card.querySelector('.cluster');
      if (!controls || !window.IntersectionObserver) return;
      if (!observer) {
        observer = new window.IntersectionObserver(function (entries) {
          UI.byId('dock').hidden = entries[entries.length - 1].isIntersecting;
        }, { threshold: 0.5 });
      }
      observer.observe(controls);
    }

    function stopWatching() {
      if (observer) observer.disconnect();
      UI.byId('dock').hidden = true;
    }

    // Returns true when a new decision took focus.
    function renderDecision(room, takeFocus) {
      var dv = RV.decisionView(room);
      if (!changed('decision', JSON.stringify([dv ? dv.key : null, RV.recordKey(room)]))) return false;
      var slot = UI.byId('decision-slot');
      if (!dv) {
        ui.fill(slot, null);
        watchDecision(null);
        return false;
      }
      // Motion only for a card that appears after the step's first render, never one already pending at page load.
      var enter = started && dv.key !== shownDecision;
      shownDecision = dv.key;
      ui.fill(slot, decisionCard(dv, enter));
      wireDecision(dv);
      UI.byId('dock-text').textContent = dv.dock.text;
      UI.byId('dock-answer').textContent = dv.dock.action;
      watchDecision(UI.byId('decision-card'));
      // Focus moves only for the person's own action, or when they are already at the bottom.
      if (!takeFocus) return false;
      UI.byId('decision-title').focus();
      return true;
    }

    // ---- outcome and problem ----

    // Server-driven, so not an alert: the header status already says it.
    function problemBlock(pb) {
      var resume = pb.canResume
        ? html`<div class="cluster"><button class="btn btn--primary btn--small" type="button" id="resume-btn">${A.text.resume}</button></div>`
        : false;
      return UI.callout('danger', html`<p>${pb.text}</p>${resume}<div id="resume-error" hidden></div>`);
    }

    function outcomeBlock(oc, room, enter) {
      return html`<div class="outcome outcome--${oc.tone}${enter ? ' outcome--enter' : ''}"><div class="outcome__body"><h2 class="outcome__title">${oc.text}</h2></div><a class="btn btn--primary" href="${UI.url(Links.briefPath(A.roomId, room.seat))}">${oc.linkLabel}</a></div>`;
    }

    function wireResume() {
      var resume = UI.byId('resume-btn');
      if (!resume) return;
      resume.addEventListener('click', function () {
        ui.act({
          busy: resume,
          error: 'resume-error',
          kind: 'resume',
          send: function () { return A.post(A.room.seat, 'resume', {}); },
          done: function () {
            return A.refresh().then(function (applied) {
              if (applied) UI.byId('room-status').focus();
              return applied;
            });
          }
        });
      });
    }

    // Starts a fresh demo room and goes to it; one try at a time.
    function startReplay(btn) {
      replayed = true;
      ui.act({
        busy: btn,
        error: 'replay-error',
        kind: 'demo',
        send: function () { return UI.request('POST', '/api/demo', {}); },
        ok: function (res) { return res.ok && Boolean(Links.demoUrl(res.data)); },
        done: function (res) {
          location.assign(UI.url(Links.demoUrl(res.data)));
          return true;
        },
        fail: function () { replayed = false; }
      });
    }

    function wireReplay() {
      var replay = UI.byId('replay-btn');
      if (!replay) return;
      replay.disabled = replayed;
      replay.addEventListener('click', function () { startReplay(replay); });
    }

    function renderOutcome(room) {
      var oc = RV.outcome(room);
      var pb = RV.problem(room);
      var replayable = Boolean(oc && oc.replayable);
      if (!changed('outcome', JSON.stringify([oc, pb, room.seat, replayable, room.status]))) return;
      var replay = replayable ? html`<div class="cluster"><button class="btn btn--secondary" type="button" id="replay-btn">${A.text.replay}</button><div id="replay-error" hidden></div></div>` : false;
      var enter = Boolean(oc) && started && oc.text !== shownOutcome;
      shownOutcome = oc ? oc.text : null;
      ui.fill(UI.byId('outcome-slot'), oc || pb ? html`${oc ? outcomeBlock(oc, room, enter) : false}${pb ? problemBlock(pb) : false}${replay}` : null);
      wireResume();
      wireReplay();
    }

    // ---- details: built once, then patched ----

    function recordBlock() {
      var text = A.text;
      return html`<details class="disclosure" id="details-record">
        <summary>${text.recordSummary}</summary>
        <div class="disclosure__body stack stack--sm">
          <div><span class="status" id="record-status"></span></div>
          <ol class="record-list" id="record-list"></ol>
          <div><a class="btn btn--link" href="${UI.url(A.ledgerPath())}" target="_blank" rel="noopener">${text.rawRecord}</a></div>
          <p class="text-caption" id="record-error" hidden></p>
        </div>
      </details>`;
    }

    // The colon and space after the label stay in the text, so a copied row reads "label: hash".
    function rowText(room, e) { return RV.recordLine(room, e) + ': '; }

    // The instructions cards change only when a card does.
    function renderInstructions(room) {
      var cardHashes = ['A', 'B'].map(function (s) { return (room.seats[s] && room.seats[s].cardHash) || ''; });
      if (!changed('cards', JSON.stringify([room.seat, room.demo, cardHashes]))) return;
      var cards = [];
      if (room.demo) cards = [ui.instructionsCard('A'), ui.instructionsCard('B')];
      else if (room.seat) cards = [ui.instructionsCard(room.seat)];
      UI.render(UI.byId('details-instructions-body'), html`${cards}`);
      UI.byId('details-instructions').hidden = !cards.some(Boolean);
    }

    // Wording depends on names, so every row is rewritten when a name changes; otherwise only the rows
    // past the last one shown are looked at.
    function renderRows(room) {
      var renamed = changed('names', RV.recordKey(room));
      var ledger = room.ledger || [];
      var list = UI.byId('record-list');
      for (var i = renamed ? 0 : rowCount; i < ledger.length; i++) {
        var e = ledger[i];
        if (rows[e.n]) {
          if (renamed) rows[e.n].textContent = rowText(room, e);
          continue;
        }
        var li = document.createElement('li');
        li.className = 'record-list__item';
        UI.render(li, html`<span>${rowText(room, e)}</span><span class="record-list__hash">${e.hash}</span>`);
        rows[e.n] = li.firstChild;
        list.appendChild(li);
      }
      rowCount = ledger.length;
    }

    function renderRecord(room) {
      var ok = Boolean(room.ledgerCheck && room.ledgerCheck.ok);
      if (changed('recordOk', ok)) {
        var status = UI.byId('record-status');
        status.className = 'status status--' + (ok ? 'ok' : 'danger');
        status.textContent = RV.recordStatus(ok);
      }
      renderRows(room);
      var message = room.error ? A.text.errorDetails + ' ' + RV.str(room.error) : '';
      if (changed('error', message)) {
        var err = UI.byId('record-error');
        err.textContent = message;
        err.hidden = !room.error;
      }
    }

    // ---- the conversation as a whole ----

    function nearBottom(height) {
      return window.innerHeight + window.scrollY >= height - 240;
    }

    // Follows new content down when the person was already at the bottom. Reads the page height again
    // only if something was written.
    function scrollIfGrew(before, near, eligible) {
      if (!near || !eligible || !touched) return;
      var after = document.documentElement.scrollHeight;
      if (after > before) window.scrollTo({ top: after, behavior: A.reduceMotion ? 'auto' : 'smooth' });
    }

    function update() {
      var room = A.room;
      var first = !started;
      var before = document.documentElement.scrollHeight;
      var near = first || nearBottom(before);
      var focusBefore = document.activeElement;
      touched = false;

      renderPill(room);
      renderConnectIfChanged();

      var hadMessages = (room.envelopes || []).length > 0;
      var chat = reconcileChat(room, first);
      renderTail(room);
      var focusedDecision = renderDecision(room, Boolean(A.pendingFocus) || near);
      if (chat.answered) {
        A.pendingFocus = null;
        var line = chat.answered.querySelector('[data-kind="answered"]');
        if (line && !focusedDecision) line.focus();
      }
      renderOutcome(room);
      renderInstructions(room);
      renderRecord(room);

      if (first) started = true;
      else if (document.activeElement === focusBefore) {
        // One silent announcement for the whole update, and none when focus already moved.
        var say = RV.chatAnnouncement(room, chat.plan, chat.plan.prev);
        if (say) UI.announce(say);
      }

      scrollIfGrew(before, near, hadMessages || !first);
    }

    return ui.defineStep({ view: view, wire: wire, update: update, unmount: unmount });
  })();

  // The dock's button takes the person to the decision card.
  UI.byId('dock-answer').addEventListener('click', function () {
    var card = UI.byId('decision-card');
    if (!card) return;
    card.scrollIntoView({ behavior: A.reduceMotion ? 'auto' : 'smooth', block: 'center' });
    UI.byId('decision-title').focus({ preventScroll: true });
  });
})();
