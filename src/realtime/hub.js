'use strict';

/**
 * Lightweight SSE hub — push clinic events to open browser tabs per userId.
 * (One-way server→client; no extra npm dependency. Same UX as a notify-only WebSocket.)
 */

/** @type {Map<string, Set<import('http').ServerResponse>>} */
const clientsByUser = new Map();

function addClient(userId, res) {
  const key = String(userId);
  let set = clientsByUser.get(key);
  if (!set) {
    set = new Set();
    clientsByUser.set(key, set);
  }
  set.add(res);
  return () => {
    set.delete(res);
    if (set.size === 0) clientsByUser.delete(key);
  };
}

function writeEvent(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Broadcast to all SSE clients for a user (and optionally everyone if userId null).
 * @param {string} event
 * @param {object} payload
 * @param {{ userId?: string|null }} [opts]
 */
function broadcast(event, payload, { userId = null } = {}) {
  const body = { ...payload, at: new Date().toISOString() };
  if (userId != null) {
    const set = clientsByUser.get(String(userId));
    if (!set) return 0;
    let n = 0;
    for (const res of set) {
      try {
        writeEvent(res, event, body);
        n += 1;
      } catch {
        /* ignore broken pipe */
      }
    }
    return n;
  }
  let n = 0;
  for (const set of clientsByUser.values()) {
    for (const res of set) {
      try {
        writeEvent(res, event, body);
        n += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return n;
}

function clientCount(userId = null) {
  if (userId != null) return clientsByUser.get(String(userId))?.size || 0;
  let n = 0;
  for (const set of clientsByUser.values()) n += set.size;
  return n;
}

module.exports = {
  addClient,
  broadcast,
  clientCount,
  writeEvent,
};
