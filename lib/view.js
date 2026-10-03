'use strict';
// What a client may see of a room (never the other side's card or tokens), and the seat-token check.
const crypto = require('crypto');
const pxp = require('./pxp');

function authSeat(room, seatId, token) {
  const s = room && room.seats && room.seats[seatId];
  if (!s || !token) return null;
  const a = Buffer.from(String(token).padEnd(64).slice(0, 64));
  const b = Buffer.from(s.token.padEnd(64).slice(0, 64));
  return crypto.timingSafeEqual(a, b) ? s : null;
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

module.exports = { view, authSeat };
