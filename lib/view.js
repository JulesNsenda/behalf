'use strict';
// What a client may see of a room (never the other side's card or tokens), and the seat-token check.
const crypto = require('crypto');
const pxp = require('./pxp');

const digest = (s) => crypto.createHash('sha256').update(typeof s === 'string' ? s : '', 'utf8').digest();

// Constant-time equality of two secrets, as SHA-256 digests: equal length for any input, so a multibyte or padded
// value can neither throw nor match. Anything that is not a string counts as ''.
function safeEqual(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// Only the seats A and B, as own properties (so 'constructor' and '__proto__' are not seats).
function authSeat(room, seatId, token) {
  if (seatId !== 'A' && seatId !== 'B') return null;
  const s = room && room.seats && Object.prototype.hasOwnProperty.call(room.seats, seatId) ? room.seats[seatId] : null;
  if (!s || typeof s.token !== 'string' || typeof token !== 'string' || !token) return null;
  return safeEqual(token, s.token) ? s : null;
}

// live is the proxy's live flag, a boolean the caller reads per call.
function view(room, seatId, token, { publicUrl, live }) {
  const mine = seatId && authSeat(room, seatId, token) ? seatId : null;
  const seats = {};
  for (const s of ['A', 'B']) {
    const st = room.seats[s];
    seats[s] = {
      name: (st.card && st.card.principal.name) || st.name || `Seat ${s}`,
      role: st.card ? st.card.principal.role : '',
      sealed: st.sealed, cardHash: st.cardHash, drafted: Boolean(st.card),
      mode: st.mode || 'builtin', agent: st.agent || null, sealedVia: st.sealedVia || null,
    };
    if (mine === s || (room.demo && mine)) { seats[s].card = st.card; seats[s].draftText = st.draftText; }
  }
  return {
    id: room.id, topic: room.topic, demo: room.demo, status: room.status, createdAt: room.createdAt,
    seat: mine, seats, envelopes: room.envelopes, claims: Object.values(room.claims),
    turn: room.turn, turnCount: room.turnCount, maxTurns: room.maxTurns,
    pending: room.pending, error: room.error, brief: room.brief, interrupted: room.interrupted || false,
    ledger: room.ledger.map(e => ({ n: e.n, type: e.type, at: e.at, hash: e.hash, prev: e.prev, data: e.data })),
    ledgerCheck: pxp.verifyLedger(room.ledger),
    thinking: room.thinking || null, waitingOn: room.waitingOn || null,
    live, mcpUrl: `${publicUrl}/mcp`,
  };
}

module.exports = { view, authSeat, safeEqual };
