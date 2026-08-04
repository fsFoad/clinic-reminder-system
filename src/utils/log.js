'use strict';

/**
 * Tiny structured logger for SMS / reminder traces.
 * One JSON line per call — grep by `"traceId":"<uuid>"`.
 * Never put API keys or full message bodies here.
 */

const { randomUUID } = require('crypto');

function newTraceId() {
  return randomUUID();
}

function write(level, fields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    ...fields,
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

const log = {
  info(fields) {
    write('info', fields);
  },
  warn(fields) {
    write('warn', fields);
  },
  error(fields) {
    write('error', fields);
  },
};

/** Mask Iranian mobile for logs: 0912***7793 / 912***7793 */
function maskMobile(raw) {
  const s = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (s.length < 7) return '***';
  const local = s.startsWith('98') && s.length >= 12 ? s.slice(2) : s;
  const with0 = local.startsWith('0') ? local : `0${local}`;
  if (with0.length < 11) return `${with0.slice(0, 4)}***`;
  return `${with0.slice(0, 4)}***${with0.slice(-4)}`;
}

module.exports = {
  log,
  newTraceId,
  maskMobile,
};
