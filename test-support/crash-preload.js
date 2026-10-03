'use strict';
// For `node -r`: a moment after start, raise an unhandled rejection (CRASH_KIND=reject) or an uncaught exception (anything
// else), carrying CRASH_TEXT, so a test can see what index.js writes for it.
const kind = process.env.CRASH_KIND;
setTimeout(() => {
  if (kind === 'reject') Promise.reject(new Error(process.env.CRASH_TEXT));
  else throw new Error(process.env.CRASH_TEXT);
}, 100);
