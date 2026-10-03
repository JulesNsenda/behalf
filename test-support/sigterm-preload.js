'use strict';
// For `node -r`: once the file named by SIGTERM_TRIGGER exists, raise SIGNAL_NAME (default SIGTERM) inside the process. It reaches the
// handlers index.js registered, on every OS (a real signal can't be sent to a child on Windows).
const fs = require('node:fs');
const trigger = process.env.SIGTERM_TRIGGER;
const timer = setInterval(() => { if (fs.existsSync(trigger)) { clearInterval(timer); process.emit(process.env.SIGNAL_NAME || 'SIGTERM'); } }, 10);
timer.unref();
