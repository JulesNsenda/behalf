'use strict';
// Any PORT that isn't a whole number in 0..65535 falls back to 3000. 0 asks the OS for a free port.
const parsePort = (s) => { const p = (s || '').trim(); return /^\d+$/.test(p) && Number(p) <= 65535 ? Number(p) : 3000; };

module.exports = { parsePort };
