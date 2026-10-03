'use strict';
// Peer-address helpers. canonicalIp gives one spelling per address (the rate-limit key and the input to every check
// here). isPrivatePeer / isLoopbackPeer say where a socket address sits, so the server only trusts forwarded headers
// from a proxy on the right network. clientIp picks the address to rate-limit. Anything unparseable is NOT private.
const net = require('net');

// How far X-Forwarded-For is trusted: never; only from loopback; from loopback, private and link-local networks
// (assumes nothing else on those networks can reach the port); or from any peer.
const TRUST_MODES = ['never', 'loopback', 'private', 'always'];

const LOOPBACK6 = '0000:0000:0000:0000:0000:0000:0000:0001';
const hex4 = (n) => n.toString(16).padStart(4, '0');

// Eight 16-bit numbers from a validated IPv6 string with no zone (an IPv4 tail counts as two groups).
function v6Groups(str) {
  let s = str;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = tail.split('.').map(Number);
    s = s.slice(0, lastColon + 1) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const rest = halves.length > 1 && halves[1] !== '' ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? new Array(8 - head.length - rest.length).fill('0') : [];
  return head.concat(fill, rest).map((g) => parseInt(g, 16));
}

// Dotted IPv4, or eight lowercase 4-digit hextets; IPv4-mapped IPv6 collapses to dotted IPv4. null when not an address.
function canonicalIp(addr) {
  if (typeof addr !== 'string') return null;
  let s = addr;
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1);
    // Brackets wrap IPv6 only, and the URL-escaped zone form (%25eth0) is not a socket address.
    if (net.isIP(s) !== 6 || s.includes('%25')) return null;
  }
  const kind = net.isIP(s); // node's grammar already rejects an empty, repeated or malformed zone, and a zone on IPv4
  if (kind === 0) return null;
  const z = s.indexOf('%');
  if (z !== -1) s = s.slice(0, z);
  if (kind === 4) return s.split('.').map(Number).join('.');
  const g = v6Groups(s);
  if (g.length !== 8) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  return g.map(hex4).join(':');
}

function isLoopbackPeer(addr) {
  const c = canonicalIp(addr);
  if (c === null) return false;
  if (c.includes('.')) return Number(c.split('.')[0]) === 127;
  return c === LOOPBACK6;
}

function isPrivatePeer(addr) {
  const c = canonicalIp(addr);
  if (c === null) return false;
  if (c.includes('.')) {
    const [a, b] = c.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const head = parseInt(c.slice(0, 4), 16);
  return c === LOOPBACK6 || (head >= 0xfc00 && head <= 0xfdff) || (head >= 0xfe80 && head <= 0xfebf);
}

// trust(req) says whether X-Forwarded-For on this request may be believed. The first request that carries the header
// from a peer we do not trust logs one fixed warning (no address), so a proxy misconfiguration is visible.
function makeTrustProxy(mode, { log } = {}) {
  let peerCheck;
  if (mode === 'always') peerCheck = () => true;
  else if (mode === 'never') peerCheck = () => false;
  else if (mode === 'loopback') peerCheck = isLoopbackPeer;
  else if (mode === 'private') peerCheck = isPrivatePeer;
  else throw new Error('Unknown trust proxy mode');
  let warned = false;
  return (req) => {
    const trusted = peerCheck(req && req.socket && req.socket.remoteAddress);
    if (!trusted && mode !== 'never' && !warned && log && req && req.headers && req.headers['x-forwarded-for'] !== undefined) {
      warned = true;
      log.warn('net.xff_ignored', {});
    }
    return trusted;
  };
}

// The key a rate limit counts an address under. An IPv4 address, or an IPv4-mapped IPv6 address in any spelling, is the IPv4; any
// other IPv6 address is its /64 (the first four hextets), so one network cannot fill a table by changing the low bits; anything
// that is not an address shares the key 'invalid'.
function rateKey(ip) {
  const c = canonicalIp(String(ip).trim().slice(0, 64));
  if (c === null) return 'invalid';
  return c.includes('.') ? c : c.split(':').slice(0, 4).join(':');
}

// The address to rate-limit: the last X-Forwarded-For entry (the one our own proxy appended) when the peer is trusted
// and the entry is a real address, otherwise the socket peer.
function clientIp(req, trust) {
  const socketIp = canonicalIp(req && req.socket && req.socket.remoteAddress) || 'unknown';
  if (!trust(req)) return socketIp;
  const raw = req.headers && req.headers['x-forwarded-for'];
  const entries = String(raw === undefined ? '' : raw).split(',').map((x) => x.trim()).filter(Boolean);
  return canonicalIp(entries[entries.length - 1]) || socketIp;
}

module.exports = { TRUST_MODES, canonicalIp, rateKey, isPrivatePeer, isLoopbackPeer, makeTrustProxy, clientIp };
