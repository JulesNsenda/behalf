'use strict';

// Words and shapes a person must never read: protocol terms and claim IDs like "B2.2".
const JARGON = /\b[AB]\d+\.\d+\b|principal|proxy|dedupe|webhook|escalat|\bcard\b/i;

module.exports = { JARGON };
