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
  // /key is the short link that lands on the connect page's key panel, so signing in from the panel comes back to it.
  var SIGNIN_NEXT = ['/', '/start', '/connect', '/key'];

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var SIGN_IN = 'Sign in with GitHub';
  var SIGN_IN_SHORT = 'Sign in'; // the header button on a narrow screen, where the GitHub mark beside it says the rest
  var SIGNIN_FAILED = "Sign-in didn't work. Please try again.";

  // The link that starts a sign-in and comes back to this page, when the page is one it can come back to.
  function signinHref(path) {
    return '/auth/github' + (SIGNIN_NEXT.indexOf(path) !== -1 ? '?next=' + path : '');
  }

  var KID = /^[0-9a-f]{12}$/; // a key's public id (lib/auth.js)
  var KEY_NAME_MAX = 40; // the longest name the server keeps, in code points (lib/auth.js; a test holds the copies together)
  var MAX_KEYS = 10; // the most live keys one person can hold (lib/auth.js MAX_KEYS_PER_USER)

  var time = function (v) { return typeof v === 'number' && isFinite(v) ? v : null; };

  // The server's /api/me answer as {signin, user: {login} | null, agentKeys: [{kid, name, createdAt, lastUsedAt}]}, or
  // null when it isn't one. Only an entry with a well-formed kid is kept; a name is kept only as text, a time only as a time.
  function parseMe(data) {
    if (data === null || typeof data !== 'object') return null;
    if (data.signin !== 'github' && data.signin !== 'off') return null;
    var user = data.user !== null && typeof data.user === 'object' ? { login: typeof data.user.login === 'string' ? data.user.login.trim() : '' } : null;
    var keys = [];
    if (user && Array.isArray(data.agentKeys)) {
      data.agentKeys.forEach(function (k) {
        if (k === null || typeof k !== 'object' || typeof k.kid !== 'string' || !KID.test(k.kid)) return;
        keys.push({ kid: k.kid, name: typeof k.name === 'string' && k.name.trim() ? k.name.trim() : null, createdAt: time(k.createdAt), lastUsedAt: time(k.lastUsedAt) });
      });
    }
    return { signin: data.signin, user: user, agentKeys: keys };
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

  var KEY_TITLE = 'Get an agent key'; // the connect page's panel: the first key, or another (KEY_TITLE_HAVE once there is one)
  var KEY_TITLE_HAVE = 'Your agent keys'; // once there is a key, new or old
  var KEY_WHAT = 'An agent key lets one of your own AI apps, like Claude Desktop or Claude Code, start rooms on Behalf for you. Make one key for each app. Rooms your apps start count towards your daily limit.';
  var KEY_PLACEHOLDER = 'YOUR_AGENT_KEY'; // stands in the command when a key exists that this page can't show

  // How a key is named in a list or a toast: its name, else "Agent key (created 3 Oct 2026, ab12)" (a key made without a name,
  // or before names existed); the first four characters of its id tell apart two made on the same day.
  function keyLabel(key) {
    if (key && typeof key.name === 'string' && key.name) return key.name;
    var date = key ? formatDate(key.createdAt) : null;
    var parts = [];
    if (date) parts.push('created ' + date);
    if (key && typeof key.kid === 'string' && KID.test(key.kid)) parts.push(key.kid.slice(0, 4));
    return parts.length ? 'Agent key (' + parts.join(', ') + ')' : 'Agent key';
  }

  // What the agent key panel on the connect page shows, or null when there is no panel (sign-in is off). shown is
  // {key, kid} for the key just created, which is the only time it can be read, else null.
  //   state       signed-out | no-key | has-key | new-key
  //   lead        the sentence under the title
  //   signin      {text, href}: the link, when signed out
  //   keys        one row per key, newest first: {kid, label, created, lastUsed, remove, removeName}; remove is the button's
  //               word, removeName what a screen reader hears for it (it names the key)
  //   nameField   {label}: the optional name for the next key, when signed in (no maxlength: browsers count UTF-16 units, the server code points)
  //   create      the button that creates a key, when signed in
  //   field       {label, note, button}: the copy field that holds the new key, once
  //   warning     the warning that goes with it
  //   commandNote what to tell about the command in the first step, or null
  //   commandKey  what the command's Authorization header carries: the new key, the placeholder when a key exists that can't
  //               be shown, else null (no header)
  function keyPanel(me, shown, path) {
    if (!me || me.signin !== 'github') return null;
    var panel = { title: KEY_TITLE, state: 'signed-out', lead: KEY_WHAT, signin: null, keys: [], nameField: null, create: null, field: null, warning: null, commandNote: null, commandKey: null };
    if (!me.user) {
      panel.signin = { text: SIGN_IN, href: signinHref(path) };
      panel.lead = 'To let your own AI app start rooms for you, sign in first. You then get an agent key to give it.';
      return panel;
    }
    var keys = me.agentKeys;
    panel.keys = keys.map(function (k) {
      var label = keyLabel(k);
      var created = formatDate(k.createdAt);
      var used = formatDate(k.lastUsedAt);
      return {
        kid: k.kid,
        label: label,
        created: created ? 'Created ' + created : null,
        lastUsed: used ? 'Last used ' + used : 'Not used yet',
        remove: 'Delete',
        removeName: 'Delete ' + label
      };
    });
    panel.nameField = { label: 'Which app is this for?' };
    panel.create = 'Create key';
    if (shown && typeof shown.key === 'string' && shown.key) {
      panel.state = 'new-key';
      panel.title = KEY_TITLE_HAVE;
      panel.lead = 'Your new key is below, and the command in step 1 now includes it.';
      panel.field = {
        label: 'Your key',
        note: "Anyone with this key can open rooms as you. It is saved in your app's settings and your command history, so treat it like a password.",
        button: 'Copy key'
      };
      panel.warning = "Copy it now. We can't show it again.";
      panel.commandNote = 'This command has your new agent key in it.';
      panel.commandKey = shown.key;
      return panel;
    }
    if (keys.length) {
      panel.state = 'has-key';
      panel.title = KEY_TITLE_HAVE;
      panel.lead = "Use one key for each app. We can't show a key again after you create it. To change an app's key, create a new one for it, then delete the old one.";
      panel.commandNote = 'In this command, replace ' + KEY_PLACEHOLDER + ' with your key.';
      panel.commandKey = KEY_PLACEHOLDER;
      return panel;
    }
    panel.state = 'no-key';
    panel.lead = KEY_WHAT + ' Create one, then add it to your app.';
    return panel;
  }

  // Short confirmations, shown as toasts. The deleted key is named by its label (keyLabel, as the panel's rows show it).
  function keyDeleted(label) { return (label || 'Your agent key') + ' no longer works.'; }
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
        key_name: 'Use a name of up to ' + KEY_NAME_MAX + ' characters.',
        key_name_taken: 'You already have a key with that name. Choose another one.',
        key_limit: 'You have as many agent keys as you can keep (' + MAX_KEYS + '). Delete one you no longer use, then try again.',
        // Creating a key ends no other key, so a failure to save leaves the others working.
        saving_unavailable: "We couldn't save your new key. Your other keys still work. Try again in a minute."
      }
    },
    keyRevoke: {
      def: "We couldn't delete that agent key. Please try again.",
      codes: {
        signin_required: 'Your sign-in has ended. Sign in again to delete an agent key.',
        origin: RELOAD,
        content_type: BAD_REQUEST,
        saving_unavailable: "We couldn't save that just now, so that key may still work. Your other keys are not affected. Try again in a minute."
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
    KEY_NAME_MAX: KEY_NAME_MAX,
    MAX_KEYS: MAX_KEYS,
    KID: KID,
    SIGNED_OUT: SIGNED_OUT,
    keyDeleted: keyDeleted,
    keyLabel: keyLabel,
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
