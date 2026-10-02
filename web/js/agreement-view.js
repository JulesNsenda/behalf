/*
 * Agreement page logic: pure functions that return plain data (strings, lists, descriptors), no markup.
 *
 * Rules:
 *  - No DOM, no UI dependency. It reads RoomView for every shared sentence (flags, reviews, the
 *    guess note, the outcome line, names), so the wording has one home. In the browser that is
 *    window.RoomView, so the page loads room-view.js first (deferred scripts run in document order).
 *  - Every function takes (R, viewerSeat, ...) and reads the brief from R.brief itself.
 *  - viewerSeat is the URL's ?seat=, which only chooses wording ("you" vs a name). It is never
 *    authority, and the agreement link never carries a token.
 *  - Server and model text is never returned as wording. Authority notes, claim text and answers
 *    come back as separate plain-text fields for the page to escape.
 *  - Summary text is built from brief fields only and contains no URLs.
 */
(function () {
  'use strict';

  var RV = typeof window !== 'undefined' ? window.RoomView : require('./room-view.js');
  if (!RV) throw new Error('load room-view.js before agreement-view.js');

  var has = Object.prototype.hasOwnProperty;

  function viewerOf(viewerSeat) { return RV.isSeat(viewerSeat) ? viewerSeat : null; }

  // The one place the shape RoomView's naming functions read is built: {seat, seats[*].name/mode/agent}.
  // The viewer is the URL's seat, and the names come from the brief's parties, falling back to the room's seats.
  function namesView(R, viewerSeat) {
    var parties = (R && R.brief && R.brief.parties) || {};
    var rooms = (R && R.seats) || {};
    var seats = {};
    ['A', 'B'].forEach(function (s) {
      var n = parties[s] && parties[s].name;
      var rs = rooms[s] || {};
      seats[s] = { name: RV.str(n).trim() ? n : rs.name, mode: rs.mode, agent: rs.agent };
    });
    return { seat: viewerOf(viewerSeat), seats: seats };
  }

  // Full name for "Between X and Y". A name RoomView replaced (reserved, or equal to the other
  // person's) stays replaced here too.
  function partyName(N, seat) {
    var full = RV.str(N.seats[seat].name).trim();
    var first = RV.firstName(N, seat);
    return full && full.split(/\s+/)[0] === first ? full : first;
  }

  // ---------- state and headings ----------

  // One of: agreed, no-deal, not-yet, not-found.
  function state(R) {
    if (!R) return 'not-found';
    var b = R.brief;
    if (!b) return 'not-yet';
    return b.outcome === 'agreed' && b.agreement ? 'agreed' : 'no-deal';
  }

  // neutral is for text a person copies out, which is read by someone who isn't the viewer.
  function heading(R, viewerSeat, neutral) {
    var N = namesView(R, viewerSeat);
    switch (state(R)) {
      case 'agreed':
        return N.seat && !neutral
          ? 'What you and ' + RV.firstName(N, RV.otherOf(N.seat)) + ' agreed'
          : 'What ' + RV.firstName(N, 'A') + ' and ' + RV.firstName(N, 'B') + ' agreed';
      case 'no-deal': return 'No deal reached';
      case 'not-yet': return "There's no agreement yet";
      default: return "We couldn't find this room";
    }
  }

  // ---------- points and authority ----------

  var UNKNOWN_AUTHORITY = "We couldn't tell what allowed this.";

  // Viewer-aware: "your instructions" only when there's a viewer seat.
  function noAuthorityNote(viewerSeat) {
    return "We couldn't check each point against " + (viewerOf(viewerSeat) ? 'your' : 'their') + ' instructions.';
  }

  // Per authority kind: [what the viewer reads, what comes before the name, what comes after it].
  var TEXT = {
    must_haves: ['One of the things you said the deal must include', 'One of the things ', ' said the deal must include'],
    may_agree_to: ['Something your AI was allowed to agree to', 'Something ', "'s AI was allowed to agree to"],
    must_never: ['Protects something you said must never happen', 'Protects something ', ' said must never happen'],
    known_facts: ['Rests on something you know for sure', 'Rests on something ', ' knows for sure'],
    amendment: ['Your answer when your AI asked you', '', "'s answer when their AI asked them"],
    none: ['Not covered by your instructions', 'Not covered by ', "'s instructions"]
  };

  // One seat's line for a term. A kind the table doesn't know is "unknown" and counts as flagged.
  function authorityLine(N, seat, kind) {
    var t = typeof kind === 'string' && has.call(TEXT, kind) ? TEXT[kind] : null;
    var text = !t ? UNKNOWN_AUTHORITY : N.seat === seat ? t[0] : t[1] + RV.firstName(N, seat) + t[2];
    return { seat: seat, kind: t ? kind : 'unknown', text: text, flagged: !t || kind === 'none' };
  }

  // Per-term "why this was allowed" lines. With no authority map there are no lines, plus one note.
  // Returns {terms: [{number, term, lines: [{seat, kind, text, flagged}], note, flagged}], note, uncovered}.
  function points(R, viewerSeat) {
    var brief = R && R.brief;
    var N = namesView(R, viewerSeat);
    var terms = brief && brief.agreement && Array.isArray(brief.agreement.terms) ? brief.agreement.terms : [];
    var auth = brief && Array.isArray(brief.authority) ? brief.authority : null;

    var out = terms.map(function (term, i) {
      var a = auth && auth[i] && typeof auth[i] === 'object' ? auth[i] : null;
      var lines = !a ? []
        : a.A === 'none' && a.B === 'none'
          ? [{ seat: 'both', kind: 'none', text: "Not covered by anyone's instructions", flagged: true }]
          : ['A', 'B'].map(function (s) { return authorityLine(N, s, a[s]); });
      return {
        number: i + 1,
        term: String(term),
        lines: lines,
        note: a ? RV.str(a.note) || null : null,
        flagged: lines.some(function (l) { return l.flagged; })
      };
    });

    return {
      terms: out,
      note: auth ? null : noAuthorityNote(viewerSeat),
      uncovered: out.filter(function (t) { return t.flagged; }).length
    };
  }

  // ---------- guesses, escalations, flags ----------

  // Reviews that aren't an accept, as sentences.
  function problemReviews(N, c) {
    return (c.reviews || []).map(function (r) {
      return RV.reviewNote(N, { by: RV.isSeat(r.by) ? r.by : 'A', verdict: r.verdict, reason: r.reason });
    }).filter(function (n) { return n.verdict !== 'accept'; }).map(function (n) {
      return { sentence: n.sentence, reason: n.reason };
    });
  }

  // "Guesses on record but not relied on": unverified claims in the record that the deal doesn't depend on.
  function guessesOnRecord(R, viewerSeat) {
    var brief = R && R.brief;
    var N = namesView(R, viewerSeat);
    var relied = {};
    (brief && Array.isArray(brief.unverified_dependencies) ? brief.unverified_dependencies : []).forEach(function (c) { relied[c.id] = true; });
    var rec = brief && Array.isArray(brief.unverified_in_record) ? brief.unverified_in_record : [];
    return rec.filter(function (c) { return !has.call(relied, c.id); }).map(function (c) {
      var seat = RV.claimSeat(c);
      return {
        text: RV.str(c.text),
        by: RV.aiName(N, seat),
        note: RV.guessNote(N, seat),
        reviews: problemReviews(N, c)
      };
    });
  }

  // "What each AI checked with its person". Uses the room page's sentences for asked and answered.
  function escalations(R, viewerSeat) {
    var brief = R && R.brief;
    var N = namesView(R, viewerSeat);
    return (brief && Array.isArray(brief.escalations) ? brief.escalations : []).map(function (e) {
      var seat = RV.isSeat(e.seat) ? e.seat : 'A';
      var q = RV.asked(N, seat, e.question);
      var a = e.answer ? RV.answered(N, seat, e.answer, e.via) : null;
      return {
        asked: q.lead,
        question: q.body,
        answered: a ? a.lead : RV.who(N, seat, 'You') + " didn't answer.",
        answer: a ? a.body : ''
      };
    });
  }

  // "The room stopped these": fixed sentences from RoomView, never the raw flag.
  function flags(R) {
    var b = R && R.brief;
    return (b && Array.isArray(b.protocol_flags) ? b.protocol_flags : []).map(function (f) { return RV.flagSentence(f); });
  }

  // ---------- AI labels and details ----------

  // "Our AI" for a built-in seat, otherwise "{agent name} (their own agent)" or "Their own agent".
  // The seat's mode decides, never the text of a label.
  function aiLabel(R, seat) {
    var rs = R && R.seats && R.seats[seat];
    if (rs && rs.mode === 'builtin') return 'Our AI';
    var agent = RV.str(rs && rs.agent).trim();
    return agent ? agent + ' (their own agent)' : 'Their own agent';
  }

  // The details disclosure: label/value rows for the record. The live record check wins over the
  // brief's copy, which is only a fallback.
  function detailRows(R, viewerSeat) {
    var brief = R && R.brief;
    var N = namesView(R, viewerSeat);
    var rows = [];
    ['A', 'B'].forEach(function (s) {
      rows.push({ label: RV.aiName(N, s), value: aiLabel(R, s), mono: false });
    });
    ['A', 'B'].forEach(function (s) {
      var h = brief && brief.parties && brief.parties[s] && brief.parties[s].card_hash;
      if (h) rows.push({ label: RV.who(N, s, 'Your') + ' instructions', value: h, mono: true });
    });
    if (brief && brief.agreement && brief.agreement.proposal_hash) rows.push({ label: 'Agreement', value: brief.agreement.proposal_hash, mono: true });
    if (brief && brief.ledger_head) rows.push({ label: 'Record', value: brief.ledger_head, mono: true });
    var live = R && R.ledgerCheck && typeof R.ledgerCheck.ok === 'boolean' ? R.ledgerCheck.ok : null;
    var ok = live !== null ? live : Boolean(brief && brief.ledger_ok);
    return { rows: rows, recordOk: ok, recordLabel: RV.recordStatus(ok) };
  }

  // ---------- no deal ----------

  // Who made a claim and what it said, for the lists on the no-deal page.
  function claimRow(N, c) {
    return { by: RV.aiName(N, RV.claimSeat(c)), text: RV.str(c.text) };
  }

  // What was claimed, and where they got stuck. Claims come from the room view; the brief holds the disputed ones.
  function noDeal(R, viewerSeat) {
    var N = namesView(R, viewerSeat);
    var claims = R && Array.isArray(R.claims) ? R.claims : [];
    var b = R && R.brief;
    return {
      claimed: claims.map(function (c) {
        return Object.assign(claimRow(N, c), { confirmed: c.origin !== 'assumed' });
      }),
      stuck: (b && Array.isArray(b.challenged) ? b.challenged : []).map(function (c) {
        return Object.assign(claimRow(N, c), { reviews: problemReviews(N, c) });
      })
    };
  }

  // ---------- plain-text summary ("Copy summary") ----------

  // Built from brief fields only. No URLs, links or tokens go in. The heading is always the
  // neutral one, because a copied summary is read by someone who isn't the viewer.
  function summaryText(R, viewerSeat) {
    var b = R && R.brief;
    var st = state(R);
    var N = namesView(R, viewerSeat);
    var out = [];
    var topic = RV.str(R && R.topic);
    out.push(heading(R, viewerSeat, true));
    if (topic) out.push('Topic: ' + topic);
    if (!b) return out.join('\n');
    out.push('Between ' + partyName(N, 'A') + ' and ' + partyName(N, 'B'));
    out.push('');
    if (st === 'agreed') {
      out.push(RV.outcome({ status: 'agreed', brief: b }).text);
      out.push('');
      var pts = points(R, viewerSeat);
      pts.terms.forEach(function (t) {
        out.push(t.number + '. ' + t.term + (t.flagged ? ' (not covered by the instructions)' : ''));
      });
      if (pts.note) { out.push(''); out.push(pts.note); }
      var deps = Array.isArray(b.unverified_dependencies) ? b.unverified_dependencies : [];
      if (deps.length) {
        out.push('');
        out.push('Relies on points nobody confirmed:');
        deps.forEach(function (c) { out.push('- ' + (c.text || '')); });
      }
    } else {
      out.push('No deal was reached.');
      var nd = noDeal(R, viewerSeat);
      if (nd.stuck.length) {
        out.push('');
        out.push('Where they got stuck:');
        nd.stuck.forEach(function (c) { out.push('- ' + c.text); });
      }
    }
    var esc = escalations(R, viewerSeat);
    if (esc.length) {
      out.push('');
      out.push('What each AI checked with its person:');
      esc.forEach(function (e) {
        out.push('- ' + e.asked + ' ' + e.question);
        out.push('  ' + e.answered + (e.answer ? ' ' + e.answer : ''));
      });
    }
    var fl = flags(R);
    if (fl.length) {
      out.push('');
      out.push('The room stopped these:');
      fl.forEach(function (f) { out.push('- ' + f.sentence); });
    }
    return out.join('\n');
  }

  var AgreementView = {
    state: state,
    heading: heading,
    noAuthorityNote: noAuthorityNote,
    points: points,
    guessesOnRecord: guessesOnRecord,
    escalations: escalations,
    flags: flags,
    aiLabel: aiLabel,
    detailRows: detailRows,
    noDeal: noDeal,
    summaryText: summaryText
  };

  if (typeof window !== 'undefined') window.AgreementView = AgreementView;
  else if (typeof module !== 'undefined' && module.exports) module.exports = AgreementView;
})();
