'use strict';

/**
 * Minimal identity wiring matching the Angular front SessionStore tokens.
 *
 * Front auth interceptor sends: Authorization: Bearer mock-{userId}
 * (see mock-backend.interceptor.ts — token = `mock-${found.id}`).
 *
 * When no Authorization header is present (curl / cron helpers), falls back to
 * DEFAULT_SETTINGS_USER_ID (default "1" = demo default user).
 */

function resolveUserIdFromAuthHeader(header) {
  const raw = String(header || '').trim();
  if (!raw) return null;

  const m = raw.match(/^Bearer\s+(.+)$/i);
  const token = (m ? m[1] : raw).trim();
  if (!token) return null;

  const mock = token.match(/^mock-(\d+)$/i);
  if (mock) return mock[1];

  // Plain numeric user id
  if (/^\d+$/.test(token)) return token;

  // Opaque / email-style token — use as stable string key (capped)
  return token.slice(0, 64);
}

function defaultUserId() {
  return String(process.env.DEFAULT_SETTINGS_USER_ID || '1');
}

/** Express middleware: sets req.userId (always a non-empty string). */
function attachUser(req, _res, next) {
  const fromHeader = resolveUserIdFromAuthHeader(req.headers.authorization);
  const fromQuery = resolveUserIdFromAuthHeader(
    req.query?.access_token ? `Bearer ${String(req.query.access_token)}` : '',
  );
  req.userId = fromHeader || fromQuery || defaultUserId();
  next();
}

module.exports = {
  attachUser,
  resolveUserIdFromAuthHeader,
  defaultUserId,
};
