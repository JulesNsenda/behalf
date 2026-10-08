'use strict';
// The invited person's welcome step (web/js/room-setup.js), run with the real room-kit.js against a fake page: the choice between our AI
// and their own is offered only when their seat is one of ours to run on a server that is live for the room. A seat that brings its own
// agent goes straight to the connect steps (before, it was shown a choice that changed nothing and then waited for ever).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { WEB } = require('../test-support/paths');
const { container } = require('../test-support/fake-page');

const realUI = require('../web/ui/ui.js');
const RoomView = require('../web/js/room-view.js');

// The welcome step for a room, drawn and wired. own: the choice this tab remembered. Returns what a person would see.
function welcome(room, { banner, own } = {}) {
  const page = { focused: null };
  const app = container(page, 'app');
  const UI = Object.assign({}, realUI, { byId: (id) => (id === 'app' ? app : app.find(id)), disableAll() {} });
  const chosen = [];
  const A = {
    room, text: RoomView.pageText(null), chosen,
    mine: () => (room.seat && room.seats ? room.seats[room.seat] : null),
    ownChoice: () => own === true,
    setOwnChoice: (v) => chosen.push(v),
    setFlag() {}, requestRender() {}, promptLink: () => 'https://behalf.test/room/r1?seat=B&t=tb',
  };
  const win = { UI, RoomView, RoomApp: A };
  win.window = win;
  const ctx = { window: win, location: { origin: 'https://behalf.test' } };
  vm.createContext(ctx);
  for (const n of ['room-kit.js', 'room-setup.js']) vm.runInContext(fs.readFileSync(path.join(WEB, 'js', n), 'utf8'), ctx, { filename: n });
  const step = A.steps.welcome;
  app.innerHTML = String(step.view());
  step.wire({ banner });
  return { A, app, el: (id) => app.find(id), choice: () => app.innerHTML.includes('id="who-builtin"') };
}

const seats = (a, b) => ({ A: { mode: a }, B: { mode: b } });
const live = (over) => ({ live: true, seat: 'B', demo: false, seats: seats('builtin', 'builtin'), ...over });

test('a built-in seat on a live server chooses between our AI and their own; our AI is the default and hides the connect steps', () => {
  const w = welcome(live());
  assert.equal(w.choice(), true);
  assert.equal(w.el('who-builtin').checked, true);
  assert.equal(w.el('who-own').checked, false);
  assert.equal(w.el('connect-steps').hidden, true);
  assert.equal(w.el('welcome-continue').textContent, w.A.text.continueButton);
});

test('choosing their own AI shows the connect steps, remembers the choice, and changes the button; going back undoes it', () => {
  const w = welcome(live());
  w.el('who-own').checked = true;
  w.el('who-own').fire('change');
  assert.deepStrictEqual(w.A.chosen, [true]);
  assert.equal(w.el('connect-steps').hidden, false);
  assert.equal(w.el('welcome-continue').textContent, w.A.text.continueOwnButton);
  w.el('who-own').checked = false;
  w.el('who-builtin').checked = true;
  w.el('who-builtin').fire('change');
  assert.deepStrictEqual(w.A.chosen, [true, false]);
  assert.equal(w.el('connect-steps').hidden, true);
});

test('a tab that chose their own AI before starts on that choice', () => {
  const w = welcome(live(), { own: true });
  assert.equal(w.el('who-own').checked, true);
  assert.equal(w.el('connect-steps').hidden, false);
  assert.equal(w.el('welcome-continue').textContent, w.A.text.continueOwnButton);
});

test('an external seat on a live server is not offered the choice: the connect steps are shown, with the button for connecting', () => {
  const w = welcome(live({ seats: seats('builtin', 'external') }));
  assert.equal(w.choice(), false);
  assert.ok(!w.app.innerHTML.includes('id="who-own"'));
  assert.equal(w.el('connect-steps').hidden, false);
  assert.equal(w.el('welcome-continue').textContent, w.A.text.continueOwnButton);
  assert.deepStrictEqual(w.A.chosen, []);
});

test('a server that is not live for the room: no choice, whatever the seat, and the connect steps stay', () => {
  for (const mode of ['external', 'builtin']) {
    const w = welcome(live({ live: false, seats: seats(mode, mode) }));
    assert.equal(w.choice(), false, mode);
    assert.equal(w.el('connect-steps').hidden, false, mode);
  }
  const external = welcome(live({ live: false, seats: seats('external', 'external') }));
  assert.equal(external.el('welcome-continue').textContent, external.A.text.continueOwnButton);
});

test('the preview (no seat yet) shows what seat B will see: the choice for a built-in seat B, the connect steps for an external one', () => {
  const builtin = welcome(live({ seat: null, seats: seats('external', 'builtin') }), { banner: 'preview' });
  assert.equal(builtin.choice(), true);
  const external = welcome(live({ seat: null, seats: seats('builtin', 'external') }), { banner: 'preview' });
  assert.equal(external.choice(), false);
  assert.equal(external.el('connect-steps').hidden, false);
  const gone = welcome(live({ seat: null, seats: undefined }), { banner: 'preview' });
  assert.equal(gone.choice(), false, 'no seats in the view: no choice');
});

test('the preview does not remember a choice', () => {
  const w = welcome(live({ seat: null, seats: seats('external', 'builtin') }), { banner: 'preview' });
  w.el('who-own').checked = true;
  w.el('who-own').fire('change');
  assert.deepStrictEqual(w.A.chosen, []);
  assert.equal(w.el('connect-steps').hidden, false, 'but it shows what choosing would show');
});

test('seat A never gets the choice here either: the welcome is for the invited seat, and an external seat A goes to the connect steps', () => {
  const w = welcome(live({ seat: 'A', seats: seats('external', 'builtin') }));
  assert.equal(w.choice(), false);
  assert.equal(w.el('connect-steps').hidden, false);
});
