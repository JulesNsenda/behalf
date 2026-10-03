'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TRUST_MODES, canonicalIp, isPrivatePeer, isLoopbackPeer, makeTrustProxy, clientIp } = require('../lib/net');

const PRIVATE = [
  '127.0.0.1', '127.255.255.255', '10.0.0.1', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.1', '192.168.255.255',
  '169.254.0.1', '169.254.255.255', '::1', 'fc00::', 'fdff::', 'fd12:3456::1', 'fe80::', 'febf::', 'fe80::1',
  '::ffff:10.0.0.1', '::FFFF:10.0.0.1', '::ffff:127.0.0.1', '::ffff:172.16.0.1', '::ffff:192.168.1.1', '::ffff:169.254.1.1',
  '::ffff:7f00:1', '::FFFF:A00:1', 'fe80::1%eth0', 'fe80::1%1', '::1%lo',
  '0::ffff:10.0.0.1', '0:0:0:0:0:0:0:1', '[::1]', '[fe80::1]', '[::ffff:10.0.0.1]', '0000:0000:0000:0000:0000:ffff:0a00:0001',
];
const NOT_PRIVATE = [
  '8.8.8.8', '1.1.1.1', '126.255.255.255', '128.0.0.1', '9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255',
  '192.169.0.0', '169.253.255.255', '169.255.0.0', '2001:db8::1', '2606:4700::1111', 'fbff::', 'fec0::', 'ff02::1', '::', '0.0.0.0',
  '::ffff:8.8.8.8', '::ffff:172.32.0.0', '::ffff:172.15.0.1', '::ffff:0.0.0.0', '::ffff:808:808', '10.0.0.1%eth0', '[10.0.0.1]%eth0', '[::1', '::1]', '',' ', 'garbage',
  '10.0.0', '10.0.0.256', '10.0.0.1.5', ' 10.0.0.1', '10.0.0.1 ', '::ffff:10.0.0', '1::fc00', '%eth0', '::1%', undefined, null, 5, {}, [],
];

test('isPrivatePeer is true for loopback, private, link-local and mapped forms', () => {
  for (const a of PRIVATE) assert.equal(isPrivatePeer(a), true, String(a));
});

test('isPrivatePeer is false for public addresses, boundaries and garbage', () => {
  for (const a of NOT_PRIVATE) assert.equal(isPrivatePeer(a), false, String(a));
});

test('makeTrustProxy always and never ignore the request', () => {
  for (const req of [undefined, {}, { socket: {} }, { socket: { remoteAddress: '8.8.8.8' } }, { socket: { remoteAddress: '10.0.0.1' } }]) {
    assert.equal(makeTrustProxy('always')(req), true);
    assert.equal(makeTrustProxy('never')(req), false);
  }
});

test('makeTrustProxy private trusts only private peers', () => {
  const f = makeTrustProxy('private');
  assert.equal(f({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(f({ socket: { remoteAddress: '::ffff:192.168.1.5' } }), true);
  assert.equal(f({ socket: { remoteAddress: '8.8.8.8' } }), false);
  assert.equal(f({ socket: { remoteAddress: undefined } }), false);
  assert.equal(f({ socket: {} }), false);
  assert.equal(f({}), false);
  assert.equal(f(undefined), false);
  assert.equal(f(null), false);
});

const ZERO7 = '0000:0000:0000:0000:0000:0000:0000:';
test('canonicalIp gives one spelling per address', () => {
  const table = [
    ['1.2.3.4', '1.2.3.4'], ['001.2.3.4', null], ['::ffff:1.2.3.4', '1.2.3.4'], ['0::ffff:1.2.3.4', '1.2.3.4'],
    ['::FFFF:102:304', '1.2.3.4'], ['0:0:0:0:0:ffff:102:304', '1.2.3.4'], ['[::ffff:1.2.3.4]', '1.2.3.4'],
    ['::1', ZERO7 + '0001'], ['0:0:0:0:0:0:0:1', ZERO7 + '0001'], ['[::1]', ZERO7 + '0001'], ['::', ZERO7 + '0000'],
    ['2001:DB8::1', '2001:0db8:0000:0000:0000:0000:0000:0001'], ['2001:db8:0:0:0:0:0:1', '2001:0db8:0000:0000:0000:0000:0000:0001'],
    ['fe80::1%eth0', 'fe80:0000:0000:0000:0000:0000:0000:0001'], ['[fe80::1%eth0]', 'fe80:0000:0000:0000:0000:0000:0000:0001'],
    ['1:2:3:4:5:6:7:8', '0001:0002:0003:0004:0005:0006:0007:0008'], ['64:ff9b::1.2.3.4', '0064:ff9b:0000:0000:0000:0000:0102:0304'],
    ['::1%a%b', null], ['[::1%25lo]', null], ['fe80::1%eth0,1', null], ['[10.0.0.1]', null], ['::1%x y', null],
    ['10.0.0.1%eth0', null],['1.2.3.4%', null], ['::1%', null], ['', null], ['garbage', null], ['1.2.3', null], ['[1.2.3.4', null],
    [undefined, null], [null, null], [5, null],
  ];
  for (const [input, want] of table) assert.equal(canonicalIp(input), want, String(input));
});

test('isLoopbackPeer is 127/8, ::1 and mapped loopback only', () => {
  for (const a of ['127.0.0.1', '127.9.9.9', '::1', '[::1]', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) assert.equal(isLoopbackPeer(a), true, a);
  for (const a of ['10.0.0.1', '192.168.1.1', 'fe80::1', 'fd00::1', '8.8.8.8', '::', '', 'x', undefined]) assert.equal(isLoopbackPeer(a), false, String(a));
});

test('TRUST_MODES lists every mode and loopback trusts only loopback', () => {
  assert.deepEqual(TRUST_MODES, ['never', 'loopback', 'private', 'always']);
  const f = makeTrustProxy('loopback');
  assert.equal(f({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(f({ socket: { remoteAddress: '10.0.0.1' } }), false);
});

function logSpy() {
  const calls = [];
  return { calls, log: { warn: (...a) => calls.push(a), info() {}, error() {} } };
}
const reqOf = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });

test('makeTrustProxy warns once, with no fields, when XFF arrives from an untrusted peer', () => {
  const { calls, log } = logSpy();
  const trust = makeTrustProxy('private', { log });
  assert.equal(trust(reqOf('10.0.0.1', '1.2.3.4')), true);
  assert.equal(trust(reqOf('8.8.8.8')), false);
  assert.equal(calls.length, 0);
  assert.equal(trust(reqOf('8.8.8.8', '1.2.3.4')), false);
  assert.deepEqual(calls, [['net.xff_ignored', {}]]);
  assert.equal(trust(reqOf('9.9.9.9', '5.6.7.8')), false);
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls).includes('8.8.8.8'));
});

test('makeTrustProxy never and always stay quiet; loopback still warns', () => {
  const a = logSpy();
  makeTrustProxy('always', { log: a.log })(reqOf('8.8.8.8', '1.1.1.1'));
  assert.equal(a.calls.length, 0);
  const n = logSpy(); // never mode ignores XFF by design, so it is not a misconfiguration worth a warning
  makeTrustProxy('never', { log: n.log })(reqOf('10.0.0.1', '1.1.1.1'));
  makeTrustProxy('never', { log: n.log })(reqOf('8.8.8.8', '1.1.1.1'));
  assert.equal(n.calls.length, 0);
  const l = logSpy();
  makeTrustProxy('loopback', { log: l.log })(reqOf('10.0.0.1', '1.1.1.1'));
  assert.equal(l.calls.length, 1);
  assert.doesNotThrow(() => makeTrustProxy('never')(reqOf('10.0.0.1', '1.1.1.1')));
});

test('clientIp ignores XFF from an untrusted peer, including the mapped form', () => {
  const trust = makeTrustProxy('private');
  assert.equal(clientIp(reqOf('8.8.8.8', '1.2.3.4'), trust), '8.8.8.8');
  assert.equal(clientIp(reqOf('::ffff:8.8.8.8', '1.2.3.4'), trust), '8.8.8.8');
  assert.equal(clientIp(reqOf('::ffff:1.2.3.4', '9.9.9.9'), trust), '1.2.3.4');
  assert.equal(clientIp(reqOf('10.0.0.1', '1.2.3.4'), makeTrustProxy('never')), '10.0.0.1');
});

test('clientIp takes the last XFF entry from a trusted peer, and falls back on junk or blanks', () => {
  const trust = makeTrustProxy('private');
  assert.equal(clientIp(reqOf('10.0.0.1', '6.6.6.6, 1.2.3.4'), trust), '1.2.3.4');
  assert.equal(clientIp(reqOf('10.0.0.1', '1.2.3.4,  '), trust), '1.2.3.4');
  assert.equal(clientIp(reqOf('10.0.0.1', '2001:db8::5'), trust), '2001:0db8:0000:0000:0000:0000:0000:0005');
  assert.equal(clientIp(reqOf('10.0.0.1', '2001:DB8::A'), trust), '2001:0db8:0000:0000:0000:0000:0000:000a');
  assert.equal(clientIp(reqOf('10.0.0.1', '::FFFF:1.2.3.4'), trust), '1.2.3.4');
  assert.equal(clientIp(reqOf('10.0.0.1', '1.2.3.4, [10.0.0.9]'), trust), '10.0.0.1');
  assert.equal(clientIp(reqOf('::ffff:10.0.0.1', '1.2.3.4'), trust), '1.2.3.4');
  assert.equal(clientIp(reqOf('garbage', '1.2.3.4'), trust), 'unknown');
  assert.equal(clientIp(reqOf('10.0.0.1', '1.2.3.4, not-an-ip'), trust), '10.0.0.1');
  assert.equal(clientIp(reqOf('10.0.0.1', ''), trust), '10.0.0.1');
  assert.equal(clientIp(reqOf('10.0.0.1', '  , '), trust), '10.0.0.1');
  assert.equal(clientIp(reqOf('10.0.0.1'), trust), '10.0.0.1');
  assert.equal(clientIp({ headers: {} }, makeTrustProxy('always')), 'unknown');
  assert.equal(clientIp({}, makeTrustProxy('never')), 'unknown');
});

test('makeTrustProxy rejects any other mode', () => {
  for (const m of [undefined, '', 'Private', 'ALWAYS', 'true', 'x', null, 1]) assert.throws(() => makeTrustProxy(m), Error, String(m));
});
