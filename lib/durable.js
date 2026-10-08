'use strict';
// The "is it durable yet" bookkeeping shared by lib/auth.js (logout, revoke, mint) and lib/ai-access.js (an admin's decision).
// createPersist({ store, canRevoke }) -> persist(kind, ids) -> Promise<boolean>: whether the store has confirmed every one of these
//   records. False, without trying, while canRevoke() says the store cannot keep a write (lib/app.js owns the policy: no grace, so a
//   change that cannot be saved never looks done). It keeps no state: lib/ai-access.js uses it alone.
// createDurable({ store, canRevoke }) -> { durable, unconfirmed }.
//  - durable(kind, ids, userId) -> Promise<boolean>: persist, but the ids are noted as unconfirmed first and forgotten once the store
//    has confirmed every one.
//  - unconfirmed: `${kind}:${id}` -> { kind, id, userId }, the ids whose write is not confirmed yet, so a retry knows they are still
//    owed. The owner of the module reads it and deletes from it (a sweep forgets what the store has since made durable).
function createPersist({ store, canRevoke }) {
  if (typeof canRevoke !== 'function') throw new TypeError('createPersist needs canRevoke');
  return async function persist(kind, ids) {
    if (!canRevoke()) return false;
    return (await Promise.all(ids.map((id) => store.persist(kind, id)))).every(Boolean);
  };
}

function createDurable({ store, canRevoke }) {
  const persist = createPersist({ store, canRevoke });
  const unconfirmed = new Map();

  async function durable(kind, ids, userId) {
    for (const id of ids) unconfirmed.set(`${kind}:${id}`, { kind, id, userId });
    const ok = await persist(kind, ids);
    if (ok) for (const id of ids) unconfirmed.delete(`${kind}:${id}`);
    return ok;
  }

  return { durable, unconfirmed };
}

module.exports = { createPersist, createDurable };
