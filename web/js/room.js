/*
 * Room page controller and boot. Every reader-facing sentence comes from RoomView; the steps (setup and
 * conversation) are registered in A.steps by room-setup.js and room-chat.js, and the state, requests and
 * stream live in room-core.js. This file mounts the step RoomView.step picks, patches the header status,
 * and hands the core its hooks. A step's scaffold is rendered once when the step changes, so typing and open
 * disclosures are never wiped by a later server update.
 */
(function () {
  'use strict';

  var UI = window.UI;
  var RV = window.RoomView;
  var html = UI.html;
  var A = window.RoomApp;

  var mountedStep = null; // the A.steps entry on the page
  var statusSig = null;
  var TONES = { info: true, ok: true, warn: true, danger: true };

  function stepId(step) { return step.key + '|' + (step.banner || ''); }

  function mountStep(step) {
    if (mountedStep) mountedStep.unmount();
    var text = A.text;
    var banner = step.banner === 'invalid-link' ? A.ui.callout('warn', text.invalidLink)
      : step.banner === 'preview' ? A.ui.callout('info', text.previewBanner) : false;
    mountedStep = A.steps[step.key] || A.steps['not-found'];
    UI.render(UI.byId('app'), html`<div class="stack stack--md">${banner}${mountedStep.view(step)}</div>`);
    mountedStep.wire(step);
  }

  function showLoadError(status) {
    try { if (mountedStep) mountedStep.unmount(); } catch (e) { /* torn down anyway by the render below */ }
    mountedStep = null;
    A.room = null;
    A.step = null;
    UI.render(UI.byId('app'), html`<div class="stack stack--md">
      ${UI.alertBox(RV.errorMessage('load', status), 'danger')}
      <div class="cluster"><button class="btn btn--primary" type="button" id="load-retry">${A.text.tryAgain}</button></div>
    </div>`);
    UI.byId('load-retry').addEventListener('click', function () { location.reload(); });
  }

  // The header status is the page's one status channel; it is a live region.
  function updateStatus(status) {
    var el = UI.byId('room-status');
    if (!status) { el.hidden = true; return; }
    var tone = TONES[status.tone] ? status.tone : 'info';
    var sig = tone + '|' + status.label;
    if (sig !== statusSig) {
      statusSig = sig;
      el.className = 'status status--' + tone;
      el.textContent = status.label;
    }
    el.hidden = false;
  }

  // Shows A.room: mounts its step when the step changed (or A.step was cleared), then patches the rest.
  function apply() {
    var room = A.room;
    var step = RV.step(room, A.stepCtx());
    var remount = !A.step || stepId(A.step) !== stepId(step);
    A.text = RV.pageText(room);
    var title = RV.docTitle(room);
    if (document.title !== title) document.title = title;
    // A.step is set only once the step is mounted, so a step that fails to build never counts as live.
    if (remount) {
      mountStep(step);
      A.step = step;
      // A step the person asked for gets focus on its heading. One the server caused is left to the status.
      var want = A.pendingFocus;
      if (want && want.steps && want.steps.indexOf(step.key) !== -1) {
        A.pendingFocus = null;
        A.ui.focusTitle();
      }
    }
    A.step = step;
    updateStatus(room ? RV.status(room) : null);
    mountedStep.update();
  }

  // The one way a room view gets in, from the first load, the stream and a refresh. True when it was
  // applied. A step that fails midway is torn down and the retry screen shown, so no stale controls stay live.
  function receive(v) {
    if (!A.validRoom(v)) return false;
    try {
      A.room = v;
      A.sideEffects();
      apply();
      return true;
    } catch (e) {
      console.warn('room update failed', e);
      showLoadError(500);
      return false;
    }
  }

  function gone() {
    A.room = null;
    A.step = null;
    try { apply(); } catch (e) {
      console.warn('room update failed', e);
      showLoadError(500);
    }
  }

  // A locked seat has nothing left to keep in the draft.
  window.addEventListener('pagehide', function () {
    var s = A.mine();
    if (s && s.sealed) A.clearDraft();
  });

  A.init();
  A.load({ onRoom: receive, onGone: gone, onLoadError: showLoadError });
})();
