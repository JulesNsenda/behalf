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

  // The step keys. A link the server turned down and the invited person's preview are not steps of their
  // own: they are banners (see step) over the step the person really sees.
  var STEPS = ['welcome', 'instructions', 'ready', 'conversation', 'spectator-drafting', 'demo-intro', 'not-found'];

  // The start page is one of this many steps.
  var STEP_COUNT = 3;

  var has = Object.prototype.hasOwnProperty;

  function isSeat(s) { return s === 'A' || s === 'B'; }

  function otherOf(seat) { return seat === 'A' ? 'B' : 'A'; }

  // Format characters (\p{Cf}: bidi controls, the zero-width space, the soft hyphen, the BOM) can reorder or
  // hide what a person reads, so every piece of agent text loses them on the way in. The zero-width
  // non-joiner and joiner stay: Persian and other scripts need them to spell, and emoji sequences use them.
  // This is the one cleaner for text from a person or an agent; no other module strips format characters.
  function str(v) { return typeof v === 'string' ? v.replace(/(?![\u200C\u200D])\p{Cf}/gu, '') : ''; }

  // A name as shown: NFKC-normalised, format characters gone, trimmed.
  function cleanName(v) { return str(typeof v === 'string' ? v.normalize('NFKC') : v).trim(); }

  // Cyrillic and Greek letters that read the same as a Latin one. Used only to compare names, never to
  // show them: "Yоu" (Cyrillic о) must not pass for "You".
  var CONFUSABLES = {
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
    'і': 'i', 'ѕ': 's', 'ј': 'j', 'ԁ': 'd', 'ӏ': 'l', 'һ': 'h', 'ԛ': 'q',
    'ԝ': 'w', 'ı': 'i',
    'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'υ': 'u', 'ν': 'v', 'ι': 'i',
    'κ': 'k', 'χ': 'x'
  };

  // Characters that draw nothing (the joiners, variation selectors, the combining grapheme joiner, ...) are
  // dropped here, for comparing only: "Yo\u200Du" and "You\uFE0F" must not slip past the "you" guard.
  function fold(name) {
    return name.replace(/\p{Default_Ignorable_Code_Point}/gu, '').toLowerCase().replace(/[^\u0000-\u007f]/g, function (c) { return has.call(CONFUSABLES, c) ? CONFUSABLES[c] : c; });
  }

  // The view's placeholder for a seat nobody has named ("Seat A").
  function isPlaceholderName(name) { return /^Seat [AB]$/.test(cleanName(name)); }

  // The name a seat has actually been given, as clean text. The view's "Seat B" placeholder gives ''.
  function givenName(seatObj) {
    var n = cleanName(seatObj && seatObj.name);
    return isPlaceholderName(n) ? '' : n;
  }

  // Wrapped in curly quotes. A straight, curly, angle or look-alike quote inside the text becomes a straight
  // apostrophe, so text from an AI can't close the quote early and pass the rest off as the room's own words.
  function quoted(v) { return '“' + str(v).replace(/["“”„‟«»‹›＂″‶〝〞〟❝❞ʺ˝]/g, "'") + '”'; }

  function cap(v) { return v.charAt(0).toUpperCase() + v.slice(1); }

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
    var name = cleanName(s && s.name);
    return name ? name.split(/\s+/)[0] : '';
  }

  // First name of a seat, from the view's seat names (never a card name from the URL).
  // A reserved name ("you", "your") or a name equal to the other seat's first name becomes
  // "Person A" / "Person B", so a name can't mimic the viewer's labels or the other person's. rawFirst
  // normalises the name (NFKC, no format characters); the comparison folds lookalike letters to Latin.
  function firstName(R, seat) {
    var raw = rawFirst(R, seat);
    if (!raw) return 'Seat ' + seat;
    var low = fold(raw);
    var other = fold(rawFirst(R, otherOf(seat)));
    if (has.call(RESERVED_NAMES, low) || (other && other === low)) return 'Person ' + seat;
    return raw;
  }

  // First name of a seat from two plain names, with the same guards as firstName. Needs no view.
  function firstNameOf(nameA, nameB, seat) {
    return firstName({ seats: { A: { name: nameA }, B: { name: nameB } } }, seat);
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
  // key is the step the person really sees. banner is a note over it: 'invalid-link' (the link had a token
  // the server didn't confirm) or 'preview' (the invited person's token-free look), else null.
  function step(R, ctx) {
    ctx = ctx || {};
    function out(key, extra) {
      return Object.assign({ key: key, banner: null, readOnly: false, connectCallout: false }, extra);
    }
    if (!R) return out('not-found', { readOnly: true });

    var drafting = R.status === 'drafting';
    var mine = R.seat && R.seats ? R.seats[R.seat] : null;

    // Demo rooms share one token so they never land here. The read-only view that follows is the step
    // the room is really in.
    if (ctx.hadCredentials && !R.seat && !R.demo) {
      return out(drafting ? 'spectator-drafting' : 'conversation', { banner: 'invalid-link', readOnly: true });
    }

    // Token-free preview of what the invited person (seat B) will see. Only while they haven't locked.
    if (!R.seat && !R.demo && ctx.previewSeat === 'B' && drafting &&
        R.seats && R.seats.B && !R.seats.B.sealed) {
      return out('welcome', { banner: 'preview', readOnly: true });
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

  // "Step 2 of 3" for the start page.
  function stepLabel(n) { return 'Step ' + n + ' of ' + STEP_COUNT; }

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
  // A room cut off by a server restart says so and blames nobody. A real failure names whose AI failed
  // from R.turn, relative to the viewer. Spectators never get a name.
  function problem(R) {
    if (!R) return null;
    var bad = R.status === 'error' || (R.status === 'paused' && R.interrupted && !R.pending);
    if (!bad) return null;
    var text = 'An AI hit a problem.';
    if (R.interrupted && !R.error) {
      text = 'The room was interrupted when the server restarted.';
    } else if (R.seat && isSeat(R.turn)) {
      text = aiName(R, R.turn) + ' hit a problem.';
    }
    return { text: text, canResume: Boolean(R.seat) };
  }

  // The dots for the side that's thinking, e.g. "Kwame's AI is thinking". Null when nobody is.
  function thinkingLabel(R) {
    if (!R || R.status !== 'negotiating' || !isSeat(R.thinking)) return null;
    return aiName(R, R.thinking) + ' is thinking';
  }

  // What sits under the last message: the dots while an AI thinks, else the line saying who the room is
  // waiting for. {kind: 'thinking' | 'waiting', label}, or null when there is nothing to show.
  function tail(R) {
    var thinking = thinkingLabel(R);
    if (thinking) return { kind: 'thinking', label: thinking };
    var waiting = R && R.status === 'negotiating' && isSeat(R.waitingOn) ? status(R).label : waitingEvent(R);
    return waiting ? { kind: 'waiting', label: waiting } : null;
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

  // Why a room ended without a deal. maxTurns counts only when it is a positive whole number.
  function noDealReason(R) {
    var n = R && R.maxTurns;
    var valid = typeof n === 'number' && isFinite(n) && n > 0 && Math.floor(n) === n;
    // A live room that stopped before its turn limit ran out of AI allowance (a demo stops when its script ends).
    if (valid && R.status === 'stalled' && !R.demo && typeof R.turnCount === 'number' && R.turnCount < n) return 'The room reached its limit on AI use.';
    return valid
      ? "The AIs didn't agree within " + n + (n === 1 ? ' turn.' : ' turns.')
      : "The AIs didn't agree in the turns they had.";
  }

  // tone and text say how it ended. linkLabel names the link to the agreement page. replayable is true
  // for a demo's own viewer, who can start it again.
  function outcome(R) {
    if (!R) return null;
    var res = null;
    if (R.status === 'agreed') {
      var n = guessCount(R);
      res = n
        ? { tone: 'warn', text: 'Deal reached, with ' + n + ' unconfirmed point' + (n === 1 ? '' : 's') }
        : { tone: 'ok', text: 'Deal reached. Nothing unconfirmed.' };
      res.linkLabel = 'See the agreement';
    } else if (R.status === 'stalled') {
      res = { tone: 'warn', text: 'No deal. ' + noDealReason(R), linkLabel: 'See what happened' };
    }
    if (res) res.replayable = Boolean(R.demo && R.seat);
    return res;
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

  // {note, detailQuote} for a claim's ref. note is fixed wording (never AI text) and sits in the claim's
  // meta row; detailQuote is the ref, quoted and attributed, for a line of its own.
  //  - stated, clause path into the instructions: note "From Kwame's instructions" (your, for the viewer)
  //  - stated, clause path into an answer: note "From Kwame's answer"
  //  - stated, anything else: the ref itself as a quoted detail
  //  - sourced, a ref that names something: "Source given: “ref”", never bare text
  //  - sourced, a clause-shaped ref: note "No source named"
  function refView(R, seat, origin, ref) {
    var none = { note: null, detailQuote: null };
    ref = str(ref);
    if (!ref) return none;
    var whose = who(R, seat, 'your');
    var parsed = parseRef(ref);
    if (origin === 'stated') {
      switch (parsed.kind) {
        case 'instruction': return { note: 'From ' + whose + ' instructions', detailQuote: null };
        case 'answer': return { note: 'From ' + whose + ' answer', detailQuote: null };
        default: return { note: null, detailQuote: quoted(ref) };
      }
    }
    if (origin === 'sourced') {
      return parsed.clause
        ? { note: 'No source named', detailQuote: null }
        : { note: null, detailQuote: 'Source given: ' + quoted(ref) };
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
    var notes = rv.map(function (r) { return reviewNote(R, r); });
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
      detailQuote: ref.detailQuote,
      reviews: notes,
      // Every review accepted: they can share the meta row. Otherwise all go in order as full lines.
      allAccepted: notes.length > 0 && notes.every(function (n) { return n.verdict === 'accept'; }),
      flagged: notes.some(function (n) { return n.verdict !== 'accept'; })
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
      terms: Array.isArray(p.terms) ? p.terms.map(str) : [],
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
      if (m) return { sentence: FLAG_RULES[i].sentence, detail: FLAG_RULES[i].quoted && str(m[1]) ? str(m[1]) : null };
    }
    return { sentence: FLAG_FALLBACK, detail: null };
  }

  // ---------- escalations ----------

  // What a seat's AI asked its person.
  function asked(R, seat, question) {
    return { kind: 'asked', lead: aiName(R, seat) + ' asked ' + who(R, seat, 'you') + ':', body: str(question), quote: quoted(question) };
  }

  // What the person answered; via is 'mcp' when it went through their own agent.
  function answered(R, seat, answer, via) {
    return {
      kind: 'answered',
      lead: who(R, seat, 'You') + ' answered' + (via === 'mcp' ? who(R, seat, 'via') : '') + ':',
      body: str(answer),
      quote: quoted(answer)
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

  // One row of the full record: "3. Kwame's AI sent a message".
  function recordLine(R, entry) {
    return (entry && entry.n) + '. ' + recordEntry(R, entry);
  }

  // Changes when the wording of the record rows does: who is viewing, and the two names.
  function recordKey(R) {
    return [R && R.seat, firstName(R, 'A'), firstName(R, 'B')].join('|');
  }

  // ---------- messages ----------

  // The "asked" line is left out while the decision card shows the same question to the person who can
  // answer it. Others see it, and so does the answering seat once the answer lands.
  function askedHidden(R, env) {
    return Boolean(canAnswer(R) && R.pending && env && R.pending.seq === env.seq && !env.answer);
  }

  function envSeat(env) { return env.from && isSeat(env.from.seat) ? env.from.seat : 'A'; }

  // The record line for a message: "Kwame's AI sent a message".
  function announceOf(R, env) {
    var type = env.status === 'escalate' ? 'escalation' : 'envelope';
    return recordEntry(R, { type: type, data: { seat: envSeat(env), status: env.status } });
  }

  // "The room stopped this: ..." for one flag's fixed sentence.
  function stoppedLine(sentence) { return 'The room stopped this: ' + sentence; }

  // A flag's quoted claim text, attributed to the AI that wrote it. Never part of the room's own sentence.
  function flagView(R, seat, flag) {
    var f = flagSentence(flag);
    return {
      sentence: f.sentence,
      detail: f.detail,
      line: stoppedLine(f.sentence),
      quote: f.detail ? aiName(R, seat) + ' wrote: ' + quoted(f.detail) : null
    };
  }

  // The visible line for one review: "Kwame's AI disagrees with this: “the reason”". The reason is the AI's
  // own text, so it is quoted.
  function reviewLine(note) {
    return note.sentence + (note.reason ? ': ' + quoted(note.reason) : '');
  }

  // Everything one chat message needs, so room.js holds no wording.
  function messageView(R, env) {
    env = env || {};
    var seat = envSeat(env);
    var speaker = aiName(R, seat);
    var agreed = env.status === 'agree';
    var hideAsked = askedHidden(R, env);
    return {
      seq: env.seq,
      seat: seat,
      end: bubbleEnd(R, seat),
      speaker: speaker,
      ariaLabel: speaker + ', message ' + env.seq,
      announce: announceOf(R, env),
      message: str(env.message),
      claims: (Array.isArray(env.claims) ? env.claims : []).map(function (c) { return claimView(R, c); }),
      proposal: proposalView(R, env),
      acceptEvent: agreed ? speaker + ' accepted the proposal' : null,
      escalationEvents: escalationEvents(R, env).filter(function (ev) { return !(ev.kind === 'asked' && hideAsked); }),
      flags: (Array.isArray(env.protocol_flags) ? env.protocol_flags : []).map(function (f) { return flagView(R, seat, f); })
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

  // The room's messages by seq (the first one wins), built once per update.
  function envelopesBySeq(R) {
    var bySeq = new Map();
    (R && Array.isArray(R.envelopes) ? R.envelopes : []).forEach(function (e) {
      if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
    });
    return bySeq;
  }

  // The seqs in plan.replace whose answer arrived with this update: no answer in the old fingerprint,
  // one in the new.
  function answeredSeqs(bySeq, plan, prevFps) {
    return plan.replace.filter(function (seq) {
      var env = bySeq.get(seq);
      return Boolean(env && env.answer && !fingerprintAnswered(prevFps[seq]));
    });
  }

  // The one polite line for a chat update: new messages plus answers added to existing ones. Null when
  // nothing worth saying changed.
  function chatAnnouncement(R, plan, prevFps) {
    if (!plan || !R) return null;
    var added = plan.add;
    var bySeq = envelopesBySeq(R);
    var answered = answeredSeqs(bySeq, plan, prevFps || {});
    if (!answered.length) return newMessagesAnnouncement(R, added);
    if (answered.length === 1 && !added.length) {
      var env = bySeq.get(answered[0]);
      return recordEntry(R, { type: 'principal_answer', data: { seat: envSeat(env), via: env.answer_via } });
    }
    return (added.length + answered.length) + ' new updates';
  }

  // ---------- decision ----------

  // The question the viewer can answer, or null. The heading is fixed wording naming whose AI asks; the
  // question is the AI's own text, shown quoted beneath it. The AI's reason for asking is never shown.
  // seat and seq say which question this is, so an answer can't land on a newer one.
  function decisionView(R) {
    if (!canAnswer(R)) return null;
    var p = R.pending;
    var question = str(p.question).trim() || 'Your AI has a question for you';
    var options = Array.isArray(p.options) && p.options.length
      ? p.options.map(function (o) { return { key: String(o.key), label: str(o.label) }; })
      : null;
    return {
      key: decisionKey(R),
      seat: p.seat,
      seq: p.seq,
      heading: aiName(R, p.seat) + ' asks you:',
      question: question,
      quote: quoted(question),
      options: options,
      textarea: { label: 'Your answer', hint: 'Your AI carries on from what you write' },
      visibilityNote: 'Anyone who can open this room can read your answer.',
      dock: { text: 'Your AI needs you', action: 'Answer' }
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
      404: 'This room has closed. Start a new one to keep going.',
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
      429: "You can't open a new room right now. Try again tomorrow, or watch the demo.",
      503: 'This server has no built-in AI, so each person brings their own AI agent.'
    },
    demo: {
      def: "We couldn't start the demo. Please try again."
    },
    load: {
      def: "We couldn't open this room. Please try again."
    }
  };

  // A refusal that carries a machine code gets its own sentence, which wins over the status's: the same status
  // means different things (a 503 is "no built-in AI" for a room and "not saved" for a refusal with a code).
  // Per action, the codes the server sends for it (a test reads the server source and holds the two together).
  // The sign-out and agent key actions are worded in account-view.js.
  var RESTARTING = 'Behalf is restarting. Try again in a moment.';
  var ERROR_CODES = {
    create: {
      signin_required: "The room wasn't opened because you're not signed in.",
      origin: 'Please reload the page and try again.',
      content_type: 'Something went wrong sending that. Reload the page and try again.',
      saving_unavailable: "Saving is unavailable right now, so we can't open a room. Try again in a minute.",
      user_limit: "You've opened all the rooms you can today. Try again tomorrow, or watch the demo.",
      ip_limit: "You've opened all the rooms this network can today. Try again tomorrow, or watch the demo.",
      daily_limit: "Behalf has opened all the rooms it can today. Try again tomorrow, or watch the demo."
    },
    draft: {
      shutting_down: RESTARTING + ' You can fill in the fields yourself.'
    }
  };

  // Fixed plain sentences, by the action, the HTTP status and the refusal's machine code if it carried one (a
  // field of the server's answer: untrusted, so it only ever picks among the sentences here). Never takes or
  // returns server text.
  function errorMessage(action, httpStatus, code) {
    if (httpStatus === 0) return NETWORK;
    var known = typeof action === 'string' && has.call(ERRORS, action);
    if (!known) return GENERIC;
    if (typeof code === 'string' && has.call(ERROR_CODES, action) && has.call(ERROR_CODES[action], code)) return ERROR_CODES[action][code];
    var g = ERRORS[action];
    return has.call(g, httpStatus) ? g[httpStatus] : g.def;
  }

  // ---------- reconciliation keys ----------

  // The room's claims by id (the last one wins), built once per update and handed to fingerprint.
  function claimsById(R) {
    var byId = {};
    (R && Array.isArray(R.claims) ? R.claims : []).forEach(function (c) { byId[c.id] = c; });
    return byId;
  }

  // Changes when a message's answer or its claims' review verdicts change, and when the viewer's pending
  // question for it appears or goes (the "asked" line is hidden while it is pending). byId is claimsById(R),
  // for callers that fingerprint many messages of one room.
  function fingerprint(R, env, byId) {
    env = env || {};
    var parts = [env.answer || '', env.answer_via || ''];
    byId = byId || claimsById(R);
    (Array.isArray(env.claims) ? env.claims : []).forEach(function (c) {
      var full = has.call(byId, c.id) ? byId[c.id] : c;
      parts.push(c.id + ':' + (full.reviews || []).map(function (r) { return r.by + '=' + r.verdict; }).join(','));
    });
    if (askedHidden(R, env)) parts.push('asked-hidden'); // last, and only then: part 0 and every other fingerprint stay as they were
    return JSON.stringify(parts);
  }

  // Whether a fingerprint (from fingerprint) says the message had an answer. The answer is its first part.
  function fingerprintAnswered(fp) {
    try { return Boolean(JSON.parse(fp)[0]); } catch (e) { return false; }
  }

  // What the chat has to do to match R. prevFps is {seq: fingerprint} for what is on screen.
  //   add      seqs not on screen yet, in order
  //   replace  seqs on screen whose fingerprint changed
  //   remove   seqs on screen that R no longer has
  //   fps      {seq: fingerprint} for every message R has now: what is on screen once the plan is applied
  //   prev     prevFps as handed in (an object), for chatAnnouncement
  function planChat(prevFps, R) {
    prevFps = prevFps && typeof prevFps === 'object' ? prevFps : {};
    var plan = { add: [], replace: [], remove: [], fps: {}, prev: prevFps };
    var seen = {};
    var byId = claimsById(R);
    (R && Array.isArray(R.envelopes) ? R.envelopes : []).forEach(function (env) {
      seen[env.seq] = true;
      plan.fps[env.seq] = fingerprint(R, env, byId);
      if (!has.call(prevFps, env.seq)) plan.add.push(env.seq);
      else if (prevFps[env.seq] !== plan.fps[env.seq]) plan.replace.push(env.seq);
    });
    Object.keys(prevFps).forEach(function (k) {
      if (!has.call(seen, k)) plan.remove.push(Number(k));
    });
    return plan;
  }

  // How long to wait before reconnecting after the nth failure in a row (1-based): 1s, doubling, capped
  // at 30s, with jitter. rand is a number in [0, 1).
  function backoffMs(failures, rand) {
    var base = Math.min(30000, 1000 * Math.pow(2, Math.max(0, (failures || 1) - 1)));
    var r = typeof rand === 'number' ? rand : 0;
    return Math.round(Math.min(30000, base * (0.75 + r * 0.5)));
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

  // ---------- page text ----------

  // The connector address of this server, and the command that adds it to Claude Code. With an agent key
  // (a non-empty string) the command also sends it as a header.
  function mcpUrl(origin) { return str(origin) + '/mcp'; }

  function mcpCommand(origin, key) {
    var command = 'claude mcp add --transport http behalf ' + mcpUrl(origin);
    return typeof key === 'string' && key ? command + ' --header "Authorization: Bearer ' + key + '"' : command;
  }

  // The message an agent is asked to act on, given the viewer's own room link.
  function agentPrompt(link) {
    return 'Represent me in this room: ' + str(link) + '\n' +
      'Ask me what I want before you lock anything, and check with me before you agree to anything beyond that.';
  }

  // The heading for one seat's locked instructions: "Your instructions" or "Kwame's instructions".
  function instructionsHeading(R, seat) { return who(R, seat, 'Your') + ' instructions'; }

  // The label over a proposal: "Kwame's AI proposes".
  function proposes(speaker) { return speaker + ' proposes'; }

  // The browser tab title for a room.
  function docTitle(R) {
    return (str(R && R.topic).trim() || 'Room') + ' · Behalf';
  }

  // Every fixed sentence the room page shows, with names filled in: plain strings only. R may be null,
  // and a name-bearing sentence then says "the person who set up the room" instead of a name.
  function pageText(R) {
    var creator = R ? creatorName(R) : 'the person who set up the room';
    var creatorLead = R ? creator : cap(creator);
    var invitee = R ? firstName(R, 'B') : 'the invited person';
    var other = R && isSeat(R.seat) ? firstName(R, otherOf(R.seat)) : 'the other person';
    var otherLead = R && isSeat(R.seat) ? other : cap(other);
    return {
      notFoundTitle: "We couldn't find this room.",
      startRoom: 'Start a room',
      tryAgain: 'Try again',
      reconnecting: 'Reconnecting…',
      invalidLink: "This link doesn't open your place in the room. Ask " + creator + ' to send it again, and copy the whole link.',
      spectatorDrafting: 'Both people are getting ready.',
      previewBanner: 'This is a preview. Only ' + invitee + "'s own link can act for them.",
      invitation: R ? 'Invitation from ' + creator : 'Invitation to a room',
      welcomeTitle: creatorLead + (str(R && R.topic) ? ' wants to agree on: ' + str(R && R.topic) : ' wants to agree with you.'),
      welcomeIntro: (R ? creator + "'s AI" : 'Their AI') + ' will talk with an AI that speaks for you. You tell yours what you want, and it checks with you before agreeing to anything beyond that.',
      reassure: [
        "Anyone who can open this room can read your answers to your AI's questions. Your instructions aren't shown, but your AI may quote parts of them.",
        'Nothing is final until both AIs agree, and you see a summary.',
        "This link is your key to the room. Don't forward it."
      ],
      whoLegend: 'Who speaks for you?',
      whoBuiltin: { title: 'Our AI', hint: 'Easiest. Nothing to install.' },
      whoOwn: { title: 'My own AI agent', hint: 'For example Claude Desktop or Claude Code.', note: 'Your agent takes your place when it connects.' },
      continueButton: 'Continue to your instructions',
      continueOwnButton: 'Continue',
      connect: {
        heading: 'Connect your AI agent', addressLabel: 'Connector address', copyAddress: 'Copy address',
        messageLabel: 'Message for your agent', copyMessage: 'Copy message', howTo: 'How to connect it'
      },
      instructionsTitle: 'Tell your AI what you want',
      instructionsIntro: "Write it the way you'd brief a colleague. Your instructions aren't shown in the room, but your AI may quote parts of them.",
      nameLabel: 'Your name', roleLabel: 'Your role', optional: '(optional)',
      nameError: 'Enter your name.',
      lockNote: "When you lock these instructions, your AI can't quietly change them. If it needs something more, it asks you.",
      lockButton: 'Lock instructions and start',
      externalCallout: 'Lock your instructions here, or let your agent fill them in with you.',
      connectFirst: "Connect your agent before you lock your instructions. Once the conversation starts, our AI speaks for you and your agent can't take over.",
      agentConnected: 'Your agent is connected',
      help: {
        summary: 'Help me write this', label: 'Describe what you need, in your own words',
        hint: "We'll turn it into the fields below. You can change anything.", go: 'Write a draft',
        confirm: "This will replace what you've written in the fields below.", replace: 'Replace it', keep: 'Keep mine',
        added: 'Draft added. Check each field before you lock.'
      },
      readyTitle: "You're all set",
      readyWaiting: 'Waiting for ' + other + ' to finish.',
      readyComeBack: 'Come back to this link. Your AI may stop to ask you something, and the room waits for you.',
      inviteLabel: otherLead + "'s invite link",
      inviteHint: 'Anyone with a link can act for that person. Send each link only to them.',
      copyLink: 'Copy link',
      demoBanner: R ? "You're " + creator + ' in this demo. ' + creator + "'s AI talks to " + invitee + "'s AI." : 'This is a demo. One person plays both sides.',
      demoInstructions: 'Read the instructions',
      demoStart: 'Start the demo',
      chatLabel: 'Conversation',
      connectCallout: { title: "Your agent hasn't connected yet", text: 'Add the connector address to your app, then send it the message below.' },
      answerButton: 'Answer my AI',
      answerHasToken: 'That looks like part of your private link. Take it out of your answer and try again.',
      replay: 'Replay the demo',
      resume: 'Resume',
      locked: 'Locked',
      instructionsSummary: R && R.demo ? 'Instructions' : 'Your instructions',
      recordSummary: 'View the full record',
      rawRecord: 'See the raw record',
      errorDetails: 'Error details:'
    };
  }

  var RoomView = {
    agentPrompt: agentPrompt,
    mcpUrl: mcpUrl,
    mcpCommand: mcpCommand,
    stepLabel: stepLabel,
    instructionsHeading: instructionsHeading,
    pageText: pageText,
    proposes: proposes,
    docTitle: docTitle,
    isPlaceholderName: isPlaceholderName,
    givenName: givenName,
    firstNameOf: firstNameOf,
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
    tail: tail,
    guessCount: guessCount,
    guessPill: guessPill,
    guessNote: guessNote,
    outcome: outcome,
    noDealReason: noDealReason,
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
    reviewLine: reviewLine,
    quoted: quoted,
    flagView: flagView,
    flagSentence: flagSentence,
    stoppedLine: stoppedLine,
    asked: asked,
    answered: answered,
    escalationEvents: escalationEvents,
    messageView: messageView,
    newMessagesAnnouncement: newMessagesAnnouncement,
    chatAnnouncement: chatAnnouncement,
    decisionView: decisionView,
    recordEntry: recordEntry,
    recordLine: recordLine,
    recordStatus: recordStatus,
    recordKey: recordKey,
    errorMessage: errorMessage,
    fingerprint: fingerprint,
    fingerprintAnswered: fingerprintAnswered,
    planChat: planChat,
    backoffMs: backoffMs,
    decisionKey: decisionKey,
    cardFromFields: cardFromFields,
    fieldsFromCard: fieldsFromCard,
    validateFields: validateFields
  };

  if (typeof window !== 'undefined') window.RoomView = RoomView;
  else if (typeof module !== 'undefined' && module.exports) module.exports = RoomView;
})();
