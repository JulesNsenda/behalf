'use strict';
// Fakes for tests that build the app: a proxy that never takes a turn (and says it is not live), and a logger that writes nowhere.
const { createLog } = require('../lib/log');

const fakeProxy = () => ({ live: () => false, takeTurn: async () => { throw new Error('unused'); }, draftCard: async () => ({}), mapAuthority: async () => [], MODEL: 'fake' });
const quietLog = () => createLog({ stream: { write() {} } });

module.exports = { fakeProxy, quietLog };
