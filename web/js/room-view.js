/*
 * Room page logic: pure functions that return plain data (strings, flags, descriptors), no markup.
 *
 * Rules:
 *  - No DOM, no UI dependency. Pages turn these results into markup through UI.html.
 *  - This is the home for wording shared by both pages (room and agreement).
 *  - Seat identity is ONLY the server-confirmed R.seat. The URL's ?seat= / ?preview= arrive
 *    separately (ctx) and decide wording and steps, never who the viewer is.
 *  - Server and model text is never returned as wording. Flag text is matched against the
 *    server's fixed sentences with anchored regexes and never echoed; the only quoted text
 *    is the claim text a flag carries, returned separately as `detail` (plain text).
 *  - Keep in sync with lib/pxp.js (protocol_flags texts) and the ledger entry types in index.js.
 *
 * Plain language only: no "principal", "proxy", "card", "claim ID" in anything a person reads.
 */
(function () {
  'use strict';

  var LIST_HINT = 'Put each point on its own line';

  var INSTRUCTION_FIELDS = [
    { key: 'goal', label: 'What are you trying to achieve?', required: true, list: false, hint: null },
    { key: 'must_haves', label: 'What must the deal include?', required: true, list: true, hint: LIST_HINT },
    { key: 'may_agree_to', label: 'What can your AI agree to without asking you?', required: false, list: true, hint: LIST_HINT },
    { key: 'must_never', label: 'What should it never agree to?', required: false, list: true, hint: LIST_HINT },
    { key: 'escalate_when', label: 'When should it stop and ask you?', required: false, list: true, hint: LIST_HINT },
    { key: 'known_facts', label: 'Things you know for sure', required: false, list: true,
      hint: LIST_HINT + '. Your AI can say these as your own words' }
  ];

  // The card's list fields: the clauses a ref like "must_never[0]" can point into. Mirrors
  // LIST_FIELDS in lib/pxp.js (a test compares them). INSTRUCTION_FIELDS is only the form table.
  var LIST_KEYS = ['must_haves', 'may_agree_to', 'must_never', 'escalate_when', 'known_facts'];

  // A ref that points into an intent card, e.g. "must_never[0]" or "amendment[1]".
  var CLAUSE_REF = /^([a-z_]+)\[\d+\]$/;

  // Names that would let a person pass as the viewer's own labels ("You", "Your AI").
  var RESERVED_NAMES = { you: true, your: true };

  var STEPS = ['invalid-link', 'preview', 'welcome', 'instructions', 'ready',
    'conversation', 'spectator-drafting', 'demo-intro', 'not-found'];

  var has = Object.prototype.hasOwnProperty;

  function isSeat(s) { return s === 'A' || s === 'B'; }

  function otherOf(seat) { return seat === 'A' ? 'B' : 'A'; }

  function str(v) { return typeof v === 'string' ? v : ''; }

  // kind: instruction (a card list field), answer (an amendment), else other. clause is true for
  // anything clause-shaped, whether or not the card has such a field.
  function parseRef(ref) {
    var m = typeof ref === 'string' ? CLAUSE_REF.exec(ref) : null;
    if (!m) return { kind: 'other', clause: false };
    var kind = LIST_KEYS.indexOf(m[1]) !== -1 ? 'instruction' : m[1] === 'amendment' ? 'answer' : 'other';
    return { kind: kind, clause: true };
  }

  // The first claim in R.claims with this id, or null.
  function findClaim(R, id) {
    var all = R && Array.isArray(R.claims) ? R.claims : [];
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  // ---------- names ----------

  // The naming helpers (firstName, aiName, who, ...) read only this much of R:
  //   R.seat                          the viewer's seat, 'A', 'B' or absent
  //   R.seats[seat].name / .mode / .agent
  // so agreement-view.js can hand them a view built from the brief (see namesView there).

  function rawFirst(R, seat) {
    var s = R && R.seats && R.seats[seat];
    var name = str(s && s.name).trim();
    return name ? name.split(/\s+/)[0] : '';
  }

  // First name of a seat, from the view's seat names (never a card name from the URL).
  // A reserved name ("you", "your") or a name equal to the other seat's first name becomes
  // "Person A" / "Person B", so a name can't mimic the viewer's labels or the other person's.
  function firstName(R, seat) {
    var raw = rawFirst(R, seat);
    if (!raw) return 'Seat ' + seat;
    var low = raw.toLowerCase();
    var other = rawFirst(R, otherOf(seat)).toLowerCase();
    if (has.call(RESERVED_NAMES, low) || (other && other === low)) return 'Person ' + seat;
    return raw;
  }

  function isViewer(R, seat) { return Boolean(R && R.seat && R.seat === seat); }

  // The viewer-or-name phrase for a seat; a null seat (a ledger entry with none) is "Someone".
  //   You / you: the viewer, else the first name    Your / your: the viewer, else "Kwame's"
  //   own: "your" or "their"                        via: " (through your agent)" or " (through their agent)"
  function who(R, seat, form) {
    var me = isViewer(R, seat);
    var name = seat ? firstName(R, seat) : 'Someone';
    switch (form) {
      case 'You': return me ? 'You' : name;
      case 'you': return me ? 'you' : name;
      case 'Your': return me ? 'Your' : name + "'s";
      case 'your': return me ? 'your' : name + "'s";
      case 'own': return me ? 'your' : 'their';
      case 'via': return ' (through ' + (me ? 'your' : 'their') + ' agent)';
      default: throw new TypeError('who: unknown form ' + String(form));
    }
  }

  function aiName(R, seat) { return isViewer(R, seat) ? 'Your AI' : firstName(R, seat) + "'s AI"; }

  // The other seat from the viewer's side, or null for a spectator.
  function otherSeat(R) { return R && isSeat(R.seat) ? otherOf(R.seat) : null; }

  // The person who opened the room is seat A.
  function creatorName(R) { return firstName(R, 'A'); }

  // The viewer is on the end (right) side. Spectators and other no-seat views put A on the end.
  function bubbleEnd(R, seat) {
    if (R && R.seat) return R.seat === seat;
    return seat === 'A';
  }

  // ---------- step selection ----------

  // ctx: {hadCredentials, previewSeat, welcomeSeen, demoStarted}. R is null for "not found".
  function step(R, ctx) {
    ctx = ctx || {};
    function out(key, extra) {
      return Object.assign({ key: key, readOnly: false, connectCallout: false, then: null }, extra);
    }
    if (!R) return out('not-found', { readOnly: true });

    var drafting = R.status === 'drafting';
    var mine = R.seat && R.seats ? R.seats[R.seat] : null;

    // The link had a seat or token but the server didn't confirm it. Demo rooms share one token
    // so they never land here. The read-only view that follows is named in `then`.
    if (ctx.hadCredentials && !R.seat && !R.demo) {
      return out('invalid-link', { readOnly: true, then: drafting ? 'spectator-drafting' : 'conversation' });
    }

    // Token-free preview of what the invited person (seat B) will see. Only while they haven't locked.
    if (!R.seat && !R.demo && ctx.previewSeat === 'B' && drafting &&
        R.seats && R.seats.B && !R.seats.B.sealed) {
      return out('preview', { readOnly: true });
    }

    if (drafting) {
      if (!R.seat) return out('spectator-drafting', { readOnly: true });
      if (R.demo) {
        var both = Boolean(R.seats && R.seats.A && R.seats.A.sealed && R.seats.B && R.seats.B.sealed);
        return out(ctx.demoStarted || both || (mine && mine.sealed) ? 'conversation' : 'demo-intro');
      }
      if (mine && mine.sealed) return out('ready');
      if (R.seat !== 'A' && !ctx.welcomeSeen) return out('welcome');
      return out('instructions');
    }

    var finished = R.status === 'agreed' || R.status === 'stalled';
    var callout = Boolean(R.seat && !R.demo && mine && mine.mode === 'external' && !mine.agent && !finished);
    return out('conversation', { readOnly: !R.seat, connectCallout: callout });
  }

  // ---------- status ----------

  // A total function: every input returns {label, tone}. tone is one of info|ok|warn|danger.
  function status(R) {
    R = R || {};
    var st = R.status;

    if (st === 'drafting') return { label: 'Getting ready', tone: 'info' };

    if (st === 'negotiating') {
      if (isSeat(R.waitingOn)) {
        var w = R.waitingOn;
        var s = R.seats && R.seats[w];
        var attached = Boolean(s && s.agent);
        var agent = who(R, w, 'your') + ' agent';
        return attached
          ? { label: 'Waiting for ' + agent, tone: 'info' }
          : { label: 'Waiting for ' + agent + ' to connect', tone: 'warn' };
      }
      return { label: 'Talking', tone: 'info' };
    }

    if (st === 'paused') {
      if (pendingSeat(R)) {
        return { label: canAnswer(R) ? 'Waiting for you' : waitingEvent(R), tone: 'warn' };
      }
      // Cut off by a restart with nobody to answer: it needs a restart, so it reads as a problem.
      if (R.interrupted) return { label: 'Something went wrong', tone: 'danger' };
      return { label: 'Paused', tone: 'warn' };
    }

    if (st === 'agreed') return { label: 'Deal reached', tone: 'ok' };
    if (st === 'stalled') return { label: 'No deal', tone: 'warn' };
    return { label: 'Something went wrong', tone: 'danger' };
  }

  // The seat whose AI asked the question that's waiting, or null.
  function pendingSeat(R) {
    return R && R.pending && isSeat(R.pending.seat) ? R.pending.seat : null;
  }

  // The viewer can answer the pending question: it's their seat, or this is a demo (one person plays both).
  function canAnswer(R) {
    var seat = pendingSeat(R);
    return Boolean(R && R.seat && seat && (R.demo || seat === R.seat));
  }

  // "Waiting for Kwame to answer their AI" event for a question that isn't the viewer's, else null.
  function waitingEvent(R) {
    var seat = pendingSeat(R);
    if (!seat || canAnswer(R)) return null;
    return 'Waiting for ' + firstName(R, seat) + ' to answer their AI';
  }

  // Error or interrupted room: the callout and whether the viewer can resume. Null otherwise.
  // Names whose AI failed from R.turn, relative to the viewer. Spectators never get a name.
  function problem(R) {
    if (!R) return null;
    var bad = R.status === 'error' || (R.status === 'paused' && R.interrupted && !R.pending);
    if (!bad) return null;
    var text = 'An AI hit a problem.';
    if (R.seat && isSeat(R.turn)) {
      text = aiName(R, R.turn) + ' hit a problem.';
    }
    return { text: text, canResume: Boolean(R.seat) };
  }

  // The dots for the side that's thinking, e.g. "Kwame's AI is thinking". Null when nobody is.
  function thinkingLabel(R) {
    if (!R || R.status !== 'negotiating' || !isSeat(R.thinking)) return null;
    return aiName(R, R.thinking) + ' is thinking';
  }

  // ---------- guesses and outcome ----------

  // After an agreement only the guesses the deal relies on count; before, every unconfirmed claim.
  function guessCount(R) {
    if (!R) return 0;
    if (R.status === 'agreed' && R.brief) {
      var deps = R.brief.unverified_dependencies;
      return Array.isArray(deps) ? deps.length : 0;
    }
    var claims = Array.isArray(R.claims) ? R.claims : [];
    var n = 0;
    for (var i = 0; i < claims.length; i++) if (!claims[i].verified) n++;
    return n;
  }

  function guessPill(R) {
    var n = guessCount(R);
    if (!n) return null;
    return n + (n === 1 ? ' guess' : ' guesses') + ' not confirmed';
  }

  // "Not confirmed. Kwame's AI guessed this." for one claim's seat.
  function guessNote(R, seat) {
    return 'Not confirmed. ' + aiName(R, seat) + ' guessed this.';
  }

  function outcome(R) {
    if (!R) return null;
    if (R.status === 'agreed') {
      var n = guessCount(R);
      return n
        ? { tone: 'warn', text: 'Deal reached, with ' + n + ' unconfirmed point' + (n === 1 ? '' : 's') }
        : { tone: 'ok', text: 'Deal reached. Nothing unconfirmed.' };
    }
    if (R.status === 'stalled') return { tone: 'warn', text: 'No deal' };
    return null;
  }

  // ---------- claims, reviews, proposals ----------

  function claimSeat(claim) {
    if (claim && isSeat(claim.seat)) return claim.seat;
    var c = str(claim && claim.id).charAt(0);
    return isSeat(c) ? c : 'A';
  }

  function reviewSentence(R, by, verdict) {
    var ai = aiName(R, by);
    if (verdict === 'accept') return ai + ' accepted this';
    if (verdict === 'conflict') return ai + ' disagrees with this';
    return ai + " couldn't confirm this";
  }

  // One review as {by, verdict, sentence, reason}. Anything that isn't accept or conflict is a challenge.
  function reviewNote(R, review) {
    var verdict = review.verdict === 'accept' || review.verdict === 'conflict' ? review.verdict : 'challenge';
    return { by: review.by, verdict: verdict, sentence: reviewSentence(R, review.by, verdict), reason: str(review.reason) };
  }

  // {note, detail} for a claim's ref. note is fixed wording, detail is the ref as plain text to escape.
  //  - stated, clause path into the instructions: "From Kwame's instructions" (your, for the viewer)
  //  - stated, clause path into an answer: "From Kwame's answer"
  //  - stated, anything else: the ref itself as detail
  //  - sourced, a ref that names something: the ref as note
  //  - sourced, a clause-shaped ref: "No source named"
  function refView(R, seat, origin, ref) {
    var none = { note: null, detail: null };
    if (typeof ref !== 'string' || !ref) return none;
    var whose = who(R, seat, 'your');
    var parsed = parseRef(ref);
    if (origin === 'stated') {
      switch (parsed.kind) {
        case 'instruction': return { note: 'From ' + whose + ' instructions', detail: null };
        case 'answer': return { note: 'From ' + whose + ' answer', detail: null };
        default: return { note: null, detail: ref };
      }
    }
    if (origin === 'sourced') {
      return parsed.clause ? { note: 'No source named', detail: null } : { note: ref, detail: null };
    }
    return none;
  }

  function claimView(R, claim) {
    claim = claim || {};
    var seat = claimSeat(claim);
    var origin = claim.origin === 'stated' || claim.origin === 'sourced' ? claim.origin : 'assumed';
    var pill;
    if (origin === 'stated') pill = who(R, seat, 'You') + ' told ' + who(R, seat, 'own') + ' AI this';
    else if (origin === 'sourced') pill = aiName(R, seat) + ' points to a source';
    else pill = guessNote(R, seat);

    var full = findClaim(R, claim.id);
    var rv = (full && full.reviews) || claim.reviews || [];
    var reviewNotes = rv.map(function (r) { return reviewNote(R, r); });
    var ref = refView(R, seat, origin, claim.ref);

    return {
      id: claim.id,
      text: str(claim.text),
      origin: origin,
      seat: seat,
      pill: pill,
      tone: origin === 'stated' ? 'party' : origin === 'sourced' ? 'neutral' : 'warn',
      unconfirmed: origin === 'assumed',
      note: ref.note,
      detail: ref.detail,
      reviewNotes: reviewNotes,
      flagged: reviewNotes.some(function (n) { return n.verdict !== 'accept'; })
    };
  }

  // A proposal that depends on something nobody confirmed gets "Depends on something not confirmed".
  function proposalView(R, env) {
    var p = env && env.proposal;
    if (!p) return null;
    var deps = Array.isArray(p.depends_on) ? p.depends_on : [];
    var unconfirmed = deps.some(function (d) {
      var c = findClaim(R, d);
      return Boolean(c) && !c.verified;
    });
    return {
      terms: Array.isArray(p.terms) ? p.terms : [],
      unconfirmed: unconfirmed,
      note: unconfirmed ? 'Depends on something not confirmed' : null
    };
  }

  // ---------- flags ----------

  var FLAG_FALLBACK = 'The room stopped an AI move that broke one of its rules.';

  // Anchored on the fixed texts in lib/pxp.js buildEnvelope. Quoted claim text can contain anything,
  // so those patterns use [\s\S]* between the fixed ends. A test counts the flags.push( calls in
  // lib/pxp.js against FLAG_RULE_COUNT, so a new server rule can't go unnoticed.
  var FLAG_RULES = [
    { re: /^Claim "([\s\S]*)" was tagged (?:stated|sourced) without a reference; downgraded to assumed\.$/,
      sentence: 'An AI marked a point as confirmed but gave no source, so the room counted it as a guess.', quoted: true },
    { re: /^Claim "([\s\S]*)" cited the other side as its authority; downgraded to assumed\.$/,
      sentence: "An AI said a point came from the other side's own words, so the room counted it as a guess.", quoted: true },
    { re: /^Proxy tried to agree while flagging a conflict; agreement withheld\.$/,
      sentence: "An AI tried to agree while it still disagreed with something, so the room didn't count it as a deal." },
    { re: /^Proxy agreed but there was no proposal from the other side; treated as continue\.$/,
      sentence: 'An AI said yes, but there was nothing proposed to say yes to.' },
    { re: /^Proxy tried to accept a proposal resting on [\s\S]*, which it disputed; agreement withheld\.$/,
      sentence: "An AI tried to accept a deal that rests on something it had doubted, so the room didn't count it as a deal." }
  ];

  // Returns {sentence, detail}. detail is the quoted claim text (plain text), else null.
  function flagSentence(flag) {
    var text = flag && typeof flag === 'object' ? flag.flag : flag;
    if (typeof text !== 'string') return { sentence: FLAG_FALLBACK, detail: null };
    for (var i = 0; i < FLAG_RULES.length; i++) {
      var m = FLAG_RULES[i].re.exec(text);
      if (m) return { sentence: FLAG_RULES[i].sentence, detail: FLAG_RULES[i].quoted && m[1] ? m[1] : null };
    }
    return { sentence: FLAG_FALLBACK, detail: null };
  }

  // ---------- escalations ----------

  // What a seat's AI asked its person.
  function asked(R, seat, question) {
    return { kind: 'asked', lead: aiName(R, seat) + ' asked ' + who(R, seat, 'you') + ':', body: str(question) };
  }

  // What the person answered; via is 'mcp' when it went through their own agent.
  function answered(R, seat, answer, via) {
    return {
      kind: 'answered',
      lead: who(R, seat, 'You') + ' answered' + (via === 'mcp' ? who(R, seat, 'via') : '') + ':',
      body: String(answer)
    };
  }

  // The asked and answered events for one message. Empty when the message didn't escalate.
  function escalationEvents(R, env) {
    var events = [];
    if (!env || !env.escalation || !env.from) return events;
    var seat = env.from.seat;
    events.push(asked(R, seat, env.escalation.question));
    if (env.answer) events.push(answered(R, seat, env.answer, env.answer_via));
    return events;
  }

  // ---------- record ----------

  // R first, like the other views. The entry is a ledger entry from the room view.
  function recordEntry(R, entry) {
    entry = entry || {};
    var d = entry.data && typeof entry.data === 'object' ? entry.data : {};
    var seat = isSeat(d.seat) ? d.seat : null;
    var name = who(R, seat, 'You');
    var ai = seat ? aiName(R, seat) : "Someone's AI";
    var via = d.via === 'mcp' ? who(R, seat, 'via') : '';
    switch (entry.type) {
      case 'room_opened': return 'Room opened';
      case 'card_sealed': return name + ' locked ' + who(R, seat, 'own') + ' instructions' + via;
      case 'agent_joined': return who(R, seat, 'Your') + ' agent connected';
      case 'envelope': return ai + (d.status === 'agree' ? ' accepted the proposal' : ' sent a message');
      case 'escalation': return ai + ' asked ' + who(R, seat, 'you') + ' a question';
      case 'principal_answer': return name + ' answered' + via;
      case 'agreement': return 'Deal reached';
      case 'turn_limit': return 'The AIs ran out of turns without a deal';
      default: return 'Something happened in the room';
    }
  }

  // The status line over the record: whether the hash chain still checks out.
  function recordStatus(ok) {
    return ok ? 'Record checks out' : 'Record was changed';
  }

  // ---------- messages ----------

  function envSeat(env) { return env.from && isSeat(env.from.seat) ? env.from.seat : 'A'; }

  // The record line for a message: "Kwame's AI sent a message".
  function announceOf(R, env) {
    var type = env.status === 'escalate' ? 'escalation' : 'envelope';
    return recordEntry(R, { type: type, data: { seat: envSeat(env), status: env.status } });
  }

  // Everything one chat message needs, so room.js holds no wording.
  function messageView(R, env) {
    env = env || {};
    var seat = envSeat(env);
    var speaker = aiName(R, seat);
    var agreed = env.status === 'agree';
    return {
      seq: env.seq,
      seat: seat,
      end: bubbleEnd(R, seat),
      speaker: speaker,
      ariaLabel: speaker + ', message ' + env.seq,
      announce: announceOf(R, env),
      claims: (Array.isArray(env.claims) ? env.claims : []).map(function (c) { return claimView(R, c); }),
      proposal: proposalView(R, env),
      acceptEvent: agreed ? speaker + ' accepted the proposal' : null,
      escalationEvents: escalationEvents(R, env),
      flags: (Array.isArray(env.protocol_flags) ? env.protocol_flags : []).map(function (f) { return flagSentence(f); })
    };
  }

  // One polite line for messages that arrived since the last render. Null when there are none.
  function newMessagesAnnouncement(R, newSeqs) {
    var seqs = new Set(Array.isArray(newSeqs) ? newSeqs : []);
    var all = R && Array.isArray(R.envelopes) ? R.envelopes : [];
    var found = all.filter(function (e) { return seqs.has(e.seq); });
    if (!found.length) return null;
    if (found.length === 1) return announceOf(R, found[0]);
    return found.length + ' new messages';
  }

  // ---------- decision ----------

  // The question the viewer can answer, or null. The heading is the question itself; the AI's
  // reason for asking is never shown.
  function decisionView(R) {
    if (!canAnswer(R)) return null;
    var p = R.pending;
    var question = str(p.question).trim() || 'Your AI has a question for you';
    var options = Array.isArray(p.options) && p.options.length
      ? p.options.map(function (o) { return { key: String(o.key), label: String(o.label) }; })
      : null;
    return {
      key: decisionKey(R),
      heading: question,
      question: question,
      options: options,
      textarea: { label: 'Your answer', hint: 'Your AI carries on from what you write' },
      visibilityNote: firstName(R, otherOf(p.seat)) + ' and their AI will see your answer.',
      dockText: 'Your AI needs you · Answer'
    };
  }

  // ---------- errors ----------

  var NETWORK = "We couldn't reach the server. Check your connection and try again.";
  var GENERIC = 'Something went wrong. Please try again.';
  var NO_ACCESS = "This link doesn't let you do that. Ask the person who set up the room to send it again.";

  // Per action, the codes index.js really returns for it (a test scrapes index.js and checks).
  // Body-level failures (invalid JSON 400, too large 413, unknown room 404) use the action's default.
  var ERRORS = {
    seal: {
      def: "We couldn't lock your instructions. Please try again.",
      400: 'Something is missing. Say what you are trying to achieve and add at least one thing the deal must include.',
      403: NO_ACCESS,
      409: 'Your instructions are already locked.'
    },
    draft: {
      def: "We couldn't write a draft just now. You can fill in the fields yourself.",
      400: 'Add your name and a short description first.',
      403: NO_ACCESS,
      409: 'Your instructions are already locked.',
      429: "You've used all the drafts for this place. Fill in the fields yourself.",
      502: "The drafting helper had a problem. You can fill in the fields yourself.",
      503: "This server can't write drafts. You can fill in the fields yourself."
    },
    answer: {
      def: "We couldn't send your answer. Please try again.",
      400: 'Write an answer first.',
      403: NO_ACCESS,
      409: "There's no question waiting for you. It may already be answered."
    },
    resume: {
      def: "We couldn't restart the room. Please try again.",
      403: NO_ACCESS,
      409: "The room can't be restarted right now."
    },
    create: {
      def: "We couldn't open the room. Please try again.",
      403: "That passcode didn't work. Check it and try again.",
      429: "You've reached today's limit for new rooms. Try again tomorrow, or watch the demo.",
      503: 'This server has no built-in AI, so each person brings their own AI agent.'
    },
    demo: {
      def: "We couldn't start the demo. Please try again."
    }
  };

  // Fixed plain sentences. Never takes or returns server text.
  function errorMessage(action, httpStatus) {
    if (httpStatus === 0) return NETWORK;
    var g = typeof action === 'string' && has.call(ERRORS, action) ? ERRORS[action] : null;
    if (!g) return GENERIC;
    return has.call(g, httpStatus) ? g[httpStatus] : g.def;
  }

  // ---------- reconciliation keys ----------

  // Changes when a message's answer or its claims' review verdicts change.
  function fingerprint(R, env) {
    env = env || {};
    var parts = [env.answer || '', env.answer_via || ''];
    var byId = {};
    (R && Array.isArray(R.claims) ? R.claims : []).forEach(function (c) { byId[c.id] = c; });
    (Array.isArray(env.claims) ? env.claims : []).forEach(function (c) {
      var full = has.call(byId, c.id) ? byId[c.id] : c;
      parts.push(c.id + ':' + (full.reviews || []).map(function (r) { return r.by + '=' + r.verdict; }).join(','));
    });
    return JSON.stringify(parts);
  }

  // The decision card re-renders only when this changes.
  function decisionKey(R) {
    return R && R.pending && R.pending.seq != null ? R.pending.seq : null;
  }

  // ---------- instructions form ----------

  function lines(v) {
    var arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/) : [];
    return arr.map(function (x) { return String(x).trim(); }).filter(Boolean);
  }

  function text(v) { return v == null ? '' : String(v).trim(); }

  // Form fields -> the card object the seal endpoint takes. List fields split on lines.
  // principal is {name, role, org}: the seat's own details, carried through unless the form changed them.
  function cardFromFields(fields, principal) {
    fields = fields || {};
    principal = principal || {};
    var pick = function (k) { return fields[k] != null ? text(fields[k]) : text(principal[k]); };
    var who = { name: pick('name'), role: pick('role') };
    var org = pick('org');
    if (org) who.org = org;
    var card = { principal: who, goal: text(fields.goal) };
    LIST_KEYS.forEach(function (k) { card[k] = lines(fields[k]); });
    return card;
  }

  // A (drafted or sealed) card -> form fields. Lists become one point per line.
  function fieldsFromCard(card) {
    card = card && typeof card === 'object' ? card : {};
    var p = card.principal && typeof card.principal === 'object' ? card.principal : {};
    var f = { name: text(p.name), role: text(p.role), org: text(p.org), goal: text(card.goal) };
    LIST_KEYS.forEach(function (k) { f[k] = lines(card[k]).join('\n'); });
    return f;
  }

  // Per-field plain errors. An empty object means the form can be locked.
  function validateFields(fields) {
    fields = fields || {};
    var errors = {};
    if (!text(fields.goal)) errors.goal = 'Say what you are trying to achieve.';
    if (!lines(fields.must_haves).length) errors.must_haves = 'Add at least one thing the deal must include.';
    return errors;
  }

  var RoomView = {
    STEPS: STEPS,
    INSTRUCTION_FIELDS: INSTRUCTION_FIELDS,
    LIST_KEYS: LIST_KEYS,
    FLAG_FALLBACK: FLAG_FALLBACK,
    FLAG_RULE_COUNT: FLAG_RULES.length,
    step: step,
    status: status,
    canAnswer: canAnswer,
    waitingEvent: waitingEvent,
    problem: problem,
    thinkingLabel: thinkingLabel,
    guessCount: guessCount,
    guessPill: guessPill,
    guessNote: guessNote,
    outcome: outcome,
    firstName: firstName,
    aiName: aiName,
    isSeat: isSeat,
    otherOf: otherOf,
    str: str,
    who: who,
    otherSeat: otherSeat,
    creatorName: creatorName,
    bubbleEnd: bubbleEnd,
    claimSeat: claimSeat,
    claimView: claimView,
    proposalView: proposalView,
    reviewSentence: reviewSentence,
    reviewNote: reviewNote,
    flagSentence: flagSentence,
    asked: asked,
    answered: answered,
    escalationEvents: escalationEvents,
    messageView: messageView,
    newMessagesAnnouncement: newMessagesAnnouncement,
    decisionView: decisionView,
    recordEntry: recordEntry,
    recordStatus: recordStatus,
    errorMessage: errorMessage,
    fingerprint: fingerprint,
    decisionKey: decisionKey,
    cardFromFields: cardFromFields,
    fieldsFromCard: fieldsFromCard,
    validateFields: validateFields
  };

  if (typeof window !== 'undefined') window.RoomView = RoomView;
  else if (typeof module !== 'undefined' && module.exports) module.exports = RoomView;
})();
