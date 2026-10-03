/*
 * Sign-in wording and choices: pure functions that return plain data (strings and descriptors), no markup.
 *
 * Rules:
 *  - No DOM, no UI dependency. account.js, start.js and connect.js turn these results into markup through UI.html.
 *  - The page's own path, the server's /api/me answer and the key just made are arguments, never read here.
 *  - The answers from the server are untrusted: parseMe reads only the fields it knows and checks their types.
 *  - The sentences for a refused sign-out or agent key request are here (errorMessage); a refused room is worded in room-view.js.
 *  - Keep SIGNIN_NEXT in sync with the pages beginLogin in lib/auth.js allows (a test compares them).
 *
 * Plain language only: say "agent key" (the term the server's own messages use) and explain it once.
 */
(function () {
  'use strict';

  var has = Object.prototype.hasOwnProperty;

  // The pages a sign-in can send a person back to. Any other page signs in and lands on the home page.
  var SIGNIN_NEXT = ['/', '/start', '/connect'];

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var SIGN_IN = 'Sign in with GitHub';
  var SIGN_IN_SHORT = 'Sign in'; // the header button on a narrow screen, where the GitHub mark beside it says the rest
  var SIGNIN_FAILED = "Sign-in didn't work. Please try again.";

  // The link that starts a sign-in and comes back to this page, when the page is one it can come back to.
  function signinHref(path) {
    return '/auth/github' + (SIGNIN_NEXT.indexOf(path) !== -1 ? '?next=' + path : '');
  }

  // The server's /api/me answer as {signin, user: {login} | null, agentKey: {createdAt} | null}, or null when it
  // isn't one. A key's createdAt is kept only when it is a time.
  function parseMe(data) {
    if (data === null || typeof data !== 'object') return null;
    if (data.signin !== 'github' && data.signin !== 'off') return null;
    var user = data.user !== null && typeof data.user === 'object' ? { login: typeof data.user.login === 'string' ? data.user.login.trim() : '' } : null;
    var key = null;
    if (user && data.agentKey !== null && typeof data.agentKey === 'object') {
      key = { createdAt: typeof data.agentKey.createdAt === 'number' && isFinite(data.agentKey.createdAt) ? data.agentKey.createdAt : null };
    }
    return { signin: data.signin, user: user, agentKey: key };
  }

  // What the header slot shows, or null when it stays empty (sign-in is off, or the answer couldn't be read).
  //   signed-out  text and short are the button's words (wide and narrow screens), href where it goes
  //   signed-in   who is the login (or "Signed in" when there is none); hint is the "Signed in as" that only a screen reader
  //               hears before the login, empty when who already says it; signOut is the button's word
  function slot(me, path) {
    if (!me || me.signin !== 'github') return null;
    if (!me.user) return { kind: 'signed-out', text: SIGN_IN, short: SIGN_IN_SHORT, href: signinHref(path) };
    return { kind: 'signed-in', who: me.user.login || 'Signed in', hint: me.user.login ? 'Signed in as ' : '', signOut: 'Sign out' };
  }

  // The sign-in call to action that replaces the form on the start page.
  function startPrompt() {
    return {
      lead: "Sign in with GitHub to open a room. We use it to see who is opening rooms, so one person can't use them all up.",
      button: SIGN_IN,
      href: signinHref('/start'),
      demo: 'Watch the demo instead',
      demoHref: '/#demo'
    };
  }

  // "3 Oct 2026" in UTC, so the same time reads the same everywhere. Null for anything that isn't a time.
  function formatDate(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return null;
    var d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  var KEY_TITLE = 'Your agent key';
  var KEY_WHAT = 'An agent key is a secret code that lets your own AI agent open rooms for you. Rooms your agent opens count towards your daily limit.';
  var KEY_PLACEHOLDER = 'YOUR_AGENT_KEY'; // stands in the command when a key exists that this page can't show

  // What the agent key panel on the connect page shows, or null when there is no panel (sign-in is off). shown is
  // {key, createdAt} for the key just created, which is the only time it can be read, else null.
  //   state       signed-out | no-key | has-key | new-key
  //   lead        the sentence under the title
  //   signin      {text, href}: the link, when signed out
  //   create      the button that creates a key, when signed in; label says whether it replaces one
  //   revoke      the button that deletes the key, when there is one
  //   field       {label, note, button}: the copy field that holds the new key, once
  //   warning     the warning that goes with it
  //   commandNote what to tell about the command in the first step, or null
  //   commandKey  what the command's Authorization header carries: the new key, the placeholder when a key exists that can't
  //               be shown, else null (no header)
  function keyPanel(me, shown, path) {
    if (!me || me.signin !== 'github') return null;
    var panel = { title: KEY_TITLE, state: 'signed-out', lead: KEY_WHAT, signin: null, create: null, revoke: null, field: null, warning: null, commandNote: null, commandKey: null };
    if (!me.user) {
      panel.signin = { text: SIGN_IN, href: signinHref(path) };
      panel.lead = 'To let your own AI agent open rooms for you, sign in first. You then get an agent key to give it.';
      return panel;
    }
    if (shown && typeof shown.key === 'string' && shown.key) {
      panel.state = 'new-key';
      panel.lead = 'Your new key is below, and the command in step 1 now includes it.';
      panel.field = {
        label: 'Your key',
        note: "Anyone with this key can open rooms as you. It is saved in your app's settings and your command history, so treat it like a password.",
        button: 'Copy key'
      };
      panel.warning = "Copy it now. We can't show it again.";
      panel.create = 'Create a new key';
      panel.revoke = 'Delete key';
      panel.commandNote = 'This command has your new agent key in it.';
      panel.commandKey = shown.key;
      return panel;
    }
    if (me.agentKey) {
      var date = formatDate(me.agentKey.createdAt);
      panel.state = 'has-key';
      panel.lead = (date ? 'You created an agent key on ' + date + '. ' : 'You have an agent key. ') + "We can't show it again. If you lost it, create a new one and the old one stops working.";
      panel.create = 'Create a new key';
      panel.revoke = 'Delete key';
      panel.commandNote = 'In this command, replace ' + KEY_PLACEHOLDER + ' with your key.';
      panel.commandKey = KEY_PLACEHOLDER;
      return panel;
    }
    panel.state = 'no-key';
    panel.lead = KEY_WHAT + ' Create one, then give it to your agent.';
    panel.create = 'Create an agent key';
    return panel;
  }

  // Short confirmations, shown as toasts.
  var KEY_DELETED = 'Your agent key no longer works.';
  var SIGNED_OUT = "You're signed out.";

  // ---------- refused requests ----------
  // Fixed plain sentences for the sign-out button and the agent key panel, by the action (logout, keyCreate or
  // keyRevoke), the HTTP status and the refusal's machine code. The code is untrusted (a field of the server's
  // answer) and only ever picks among the sentences here. Never takes or returns server text. Per action, the
  // codes the server sends for it (a test reads the server source and holds the two together).
  var NETWORK = "We couldn't reach the server. Check your connection and try again.";
  var GENERIC = 'Something went wrong. Please try again.';
  var RELOAD = 'Please reload the page and try again.';
  var BAD_REQUEST = 'Something went wrong sending that. Reload the page and try again.';
  var ERRORS = {
    logout: {
      def: "We couldn't sign you out. Please try again.",
      codes: {
        origin: RELOAD,
        content_type: BAD_REQUEST,
        // The sign-out itself has happened here: the cookie is cleared whatever the saving did.
        saving_unavailable: "You're signed out. It may take a moment to be recorded."
      }
    },
    keyCreate: {
      def: "We couldn't create your agent key. Please try again.",
      codes: {
        signin_required: 'Your sign-in has ended. Sign in again to create an agent key.',
        origin: RELOAD,
        content_type: BAD_REQUEST,
        rate_limited: "You've created a lot of keys in a short time. Wait a few minutes and try again.",
        // Creating a key puts the old one out first, so a failure to save leaves no working key.
        saving_unavailable: "We couldn't save your new key, so you have no working agent key right now. Try again in a minute."
      }
    },
    keyRevoke: {
      def: "We couldn't delete your agent key. Please try again.",
      codes: {
        signin_required: 'Your sign-in has ended. Sign in again to delete your agent key.',
        origin: RELOAD,
        content_type: BAD_REQUEST,
        saving_unavailable: "We couldn't save that just now, so your agent key may still work. Try again in a minute."
      }
    }
  };

  function errorMessage(action, httpStatus, code) {
    if (httpStatus === 0) return NETWORK;
    if (typeof action !== 'string' || !has.call(ERRORS, action)) return GENERIC;
    var codes = ERRORS[action].codes;
    return typeof code === 'string' && has.call(codes, code) ? codes[code] : ERRORS[action].def;
  }

  var AccountView = {
    SIGNIN_NEXT: SIGNIN_NEXT,
    SIGNIN_FAILED: SIGNIN_FAILED,
    KEY_DELETED: KEY_DELETED,
    SIGNED_OUT: SIGNED_OUT,
    KEY_PATTERN: /^bh_[A-Za-z0-9_-]{20,}$/,
    signinHref: signinHref,
    parseMe: parseMe,
    slot: slot,
    startPrompt: startPrompt,
    formatDate: formatDate,
    keyPanel: keyPanel,
    errorMessage: errorMessage
  };

  if (typeof window !== 'undefined') window.AccountView = AccountView;
  else if (typeof module !== 'undefined' && module.exports) module.exports = AccountView;
})();
