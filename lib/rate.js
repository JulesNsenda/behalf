'use strict';
// The fixed-window counter shared by lib/auth.js (callbacks per address, mints per user) and lib/ai-access.js (requests per user).
// A fixed-window counter per key, from a capped table. hit(key) is 'ok', 'first' (the first one over the cap in this window)
// or 'limited'. A key that cannot get a slot (the table is full of live windows) is counted under aggregate(key) in a second
// capped table, with its own cap; that table's last resort is one shared 'overflow' bucket.
function createRateTable({ now, windowMs, cap, overflowCap, maxKeys, aggregate }) {
  const main = new Map();
  const over = new Map();
  const prune = (map) => { const at = now(); for (const [k, v] of map) if (v.resetAt <= at) map.delete(k); };
  function bump(map, key, limit) {
    const at = now();
    let slot = map.get(key);
    if (!slot || slot.resetAt <= at) { slot = { count: 0, resetAt: at + windowMs }; map.set(key, slot); }
    slot.count++;
    return slot.count <= limit ? 'ok' : (slot.count === limit + 1 ? 'first' : 'limited');
  }
  return function hit(key) {
    if (!main.has(key) && main.size >= maxKeys) prune(main);
    if (main.has(key) || main.size < maxKeys) return bump(main, key, cap);
    let bucket = aggregate(key);
    if (!over.has(bucket) && over.size >= maxKeys) { prune(over); if (over.size >= maxKeys) bucket = 'overflow'; }
    return bump(over, bucket, overflowCap);
  };
}

module.exports = { createRateTable };
