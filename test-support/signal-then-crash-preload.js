'use strict';
// For `node -r`: once the file named by SIGTERM_TRIGGER exists, raise SIGINT inside the process, and 100 ms later an uncaught
// exception. For seeing which reason to leave index.js honours.
const fs = require('node:fs');
const trigger = process.env.SIGTERM_TRIGGER;
const timer = setInterval(() => {
  if (!fs.existsSync(trigger)) return;
  clearInterval(timer);
  process.emit('SIGINT');
  setTimeout(() => { throw new Error('crash after the signal'); }, 100);
}, 10);
timer.unref();
