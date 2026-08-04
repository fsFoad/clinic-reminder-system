'use strict';

/**
 * Minimal SMS.ir REST client (https://api.sms.ir/v1).
 * Auth header: x-api-key. Never log the API key.
 *
 * When SMSIR_DRY_RUN is false, every send/status call MUST hit the network.
 * Dry-run fake packs are only returned when SMSIR_DRY_RUN is explicitly true.
 */

const DEFAULT_BASE = 'https://api.sms.ir/v1';
const { log } = require('../utils/log');

/**
 * SMS.ir business-status codes that are account / line / auth config issues
 * (not bad request payload from our app). Docs: sms.ir/rest-api status table.
 * 123 = «خط ارسال‌کننده نیاز به فعال‌سازی دارد»
 */
const SMSIR_ACCOUNT_STATUSES = new Set([10, 11, 12, 13, 14, 101, 123]);

class SmsirError extends Error {
  constructor(httpStatus, body, message, { smsirStatus = null, traceId = null } = {}) {
    super(message || `SMS.ir HTTP ${httpStatus}`);
    this.name = 'SmsirError';
    this.httpStatus = httpStatus;
    this.body = body;
    this.traceId = traceId || null;
    const codeNum =
      smsirStatus != null && Number.isFinite(Number(smsirStatus))
        ? Number(smsirStatus)
        : body && (body.status != null || body.Status != null)
          ? Number(body.status ?? body.Status)
          : null;
    this.smsirStatus = Number.isFinite(codeNum) ? codeNum : null;
    this.code =
      this.smsirStatus != null ? `smsir_${this.smsirStatus}` : `smsir_http_${httpStatus}`;

    if (httpStatus === 401 || httpStatus === 429 || httpStatus >= 500) {
      this.status = 502;
    } else if (this.smsirStatus != null && SMSIR_ACCOUNT_STATUSES.has(this.smsirStatus)) {
      this.status = 502;
    } else if (httpStatus === 412 || httpStatus === 400) {
      this.status = 400;
    } else {
      this.status = 502;
    }
  }
}

function getConfig() {
  const apiKey = String(process.env.SMSIR_API_KEY || '').trim();
  const lineNumber = String(process.env.SMSIR_LINE_NUMBER || '').trim();
  const baseUrl = String(process.env.SMSIR_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const dryRun = ['1', 'true', 'yes'].includes(
    String(process.env.SMSIR_DRY_RUN || '').toLowerCase()
  );
  return { apiKey, lineNumber, baseUrl, dryRun };
}

function isConfigured() {
  const { apiKey, lineNumber } = getConfig();
  return Boolean(apiKey && lineNumber);
}

function assertConfigured() {
  const cfg = getConfig();
  if (!cfg.apiKey) {
    const err = new Error('SMSIR_API_KEY is not set');
    err.status = 500;
    throw err;
  }
  if (!cfg.lineNumber) {
    const err = new Error('SMSIR_LINE_NUMBER is not set');
    err.status = 500;
    throw err;
  }
  return cfg;
}

/** Strip secrets from objects before returning as `raw` to callers/logs. */
function sanitizeForLog(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  const clone = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(clone)) {
    const lower = key.toLowerCase();
    if (lower.includes('api') && lower.includes('key')) {
      clone[key] = '[redacted]';
    } else if (typeof clone[key] === 'object' && clone[key] != null) {
      clone[key] = sanitizeForLog(clone[key]);
    }
  }
  return clone;
}

function outboundPayloadForLog(body) {
  if (!body || typeof body !== 'object') return body;
  const { messageText, messageTexts, MessageTexts, ...rest } = body;
  const texts = messageTexts || MessageTexts;
  return {
    ...rest,
    messageTextLen: messageText != null ? String(messageText).length : undefined,
    messageTextsCount: Array.isArray(texts) ? texts.length : undefined,
    messageTextsLens: Array.isArray(texts)
      ? texts.map((t) => String(t == null ? '' : t).length)
      : undefined,
  };
}

async function request(method, path, { query, body, traceId = null } = {}) {
  const cfg = assertConfigured();
  const url = new URL(`${cfg.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const headers = {
    // Docs: ACCEPT application/json|xml; samples also use text/plain for send methods.
    Accept: 'text/plain',
    'Content-Type': 'application/json',
    // Official header name is X-API-KEY; some stacks normalize to lowercase.
    'X-API-KEY': cfg.apiKey,
    'x-api-key': cfg.apiKey,
  };
  const init = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  log.info({
    traceId,
    step: 'smsir_http_request',
    method,
    host: url.host,
    url: url.toString(),
    dryRun: false,
    payload: outboundPayloadForLog(body),
  });

  let res;
  try {
    res = await fetch(url, init);
  } catch (netErr) {
    log.error({
      traceId,
      step: 'smsir_http_network_error',
      method,
      host: url.host,
      url: url.toString(),
      error: netErr.message || String(netErr),
      stack: netErr.stack,
    });
    const err = new SmsirError(0, null, netErr.message || 'SMS.ir network error', { traceId });
    err.status = 502;
    throw err;
  }

  let parsed = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { rawText: text.slice(0, 500) };
  }

  const smsirStatus =
    parsed && (parsed.status != null || parsed.Status != null)
      ? Number(parsed.status ?? parsed.Status)
      : null;

  const safeBody = sanitizeForLog(parsed);

  log.info({
    traceId,
    step: 'smsir_http_response',
    method,
    host: url.host,
    url: url.toString(),
    httpStatus: res.status,
    smsirStatus,
    body: safeBody,
  });

  if (!res.ok || (smsirStatus != null && smsirStatus !== 1)) {
    const msg =
      (parsed && (parsed.message || parsed.Message)) ||
      `SMS.ir request failed (${res.status})`;
    log.error({
      traceId,
      step: 'smsir_request_failed',
      method,
      path,
      httpStatus: res.status,
      smsirStatus,
      message: msg,
      body: safeBody,
    });
    throw new SmsirError(res.status, safeBody, msg, { smsirStatus, traceId });
  }

  return parsed;
}

/**
 * Resolve lineNumber for SMS.ir (Long). Prefer Number when IEEE-safe.
 */
function resolveLineNumber(lineNumber, cfg) {
  const rawLine = String(lineNumber != null ? lineNumber : cfg.lineNumber || '').trim();
  const asNum = Number(rawLine);
  return rawLine && Number.isSafeInteger(asNum) && asNum > 0 ? asNum : rawLine || 0;
}

/**
 * POST /send/likeToLike — primary remind path (1:1 messageTexts ↔ mobiles).
 * Docs sample body uses camelCase messageTexts/mobiles/sendDateTime.
 * @param {{ messageTexts: string[], mobiles: string[], sendDateTime?: number|null, lineNumber?: string|number, traceId?: string|null }} opts
 */
async function sendLikeToLike({
  messageTexts,
  mobiles,
  sendDateTime = null,
  lineNumber,
  traceId = null,
} = {}) {
  const cfg = getConfig();
  if (!cfg.dryRun) assertConfigured();

  if (!Array.isArray(messageTexts) || messageTexts.length === 0) {
    throw new SmsirError(400, null, 'messageTexts must be a non-empty array', { traceId });
  }
  if (!Array.isArray(mobiles) || mobiles.length === 0) {
    throw new SmsirError(400, null, 'mobiles must be a non-empty array', { traceId });
  }
  if (messageTexts.length !== mobiles.length) {
    throw new SmsirError(400, null, 'messageTexts and mobiles length must match', { traceId });
  }
  if (messageTexts.some((t) => !t || !String(t).trim())) {
    throw new SmsirError(400, null, 'each messageTexts entry is required', { traceId });
  }

  const payload = {
    lineNumber: resolveLineNumber(lineNumber, cfg),
    messageTexts: messageTexts.map(String),
    mobiles: mobiles.map(String),
    sendDateTime: sendDateTime == null ? null : Number(sendDateTime),
  };

  if (cfg.dryRun) {
    const fakeId = Date.now();
    const dryResponse = {
      status: 1,
      message: 'dry_run',
      data: {
        packId: `dry-pack-${fakeId}`,
        messageIds: mobiles.map((_, i) => fakeId + i),
        cost: 0,
      },
      _dryRun: true,
      _request: { ...payload },
    };
    log.warn({
      traceId,
      step: 'smsir_send_likeToLike_dry_run',
      host: new URL(cfg.baseUrl).host,
      url: `${cfg.baseUrl}/send/likeToLike`,
      dryRun: true,
      network: false,
      payload: outboundPayloadForLog(payload),
      response: sanitizeForLog(dryResponse),
    });
    return dryResponse;
  }

  return request('POST', '/send/likeToLike', { body: payload, traceId });
}

/**
 * POST /send/bulk — legacy (one text → many mobiles). Prefer sendLikeToLike for reminders.
 * @param {{ messageText: string, mobiles: string[], sendDateTime?: number|null, lineNumber?: string|number, traceId?: string|null }} opts
 */
async function sendBulk({
  messageText,
  mobiles,
  sendDateTime = null,
  lineNumber,
  traceId = null,
} = {}) {
  const cfg = getConfig();
  if (!cfg.dryRun) assertConfigured();

  if (!messageText || !String(messageText).trim()) {
    throw new SmsirError(400, null, 'messageText is required', { traceId });
  }
  if (!Array.isArray(mobiles) || mobiles.length === 0) {
    throw new SmsirError(400, null, 'mobiles must be a non-empty array', { traceId });
  }

  const payload = {
    lineNumber: resolveLineNumber(lineNumber, cfg),
    messageText: String(messageText),
    mobiles: mobiles.map(String),
    sendDateTime: sendDateTime == null ? null : Number(sendDateTime),
  };

  if (cfg.dryRun) {
    const fakeId = Date.now();
    const dryResponse = {
      status: 1,
      message: 'dry_run',
      data: {
        packId: `dry-pack-${fakeId}`,
        messageIds: [fakeId],
        cost: 0,
      },
      _dryRun: true,
      _request: { ...payload, lineNumber: payload.lineNumber },
    };
    log.warn({
      traceId,
      step: 'smsir_send_bulk_dry_run',
      host: new URL(cfg.baseUrl).host,
      url: `${cfg.baseUrl}/send/bulk`,
      dryRun: true,
      network: false,
      payload: outboundPayloadForLog(payload),
      response: sanitizeForLog(dryResponse),
    });
    return dryResponse;
  }

  return request('POST', '/send/bulk', { body: payload, traceId });
}

async function receiveLatest({ count = 50, traceId = null } = {}) {
  const cfg = getConfig();
  if (cfg.dryRun) return { status: 1, message: 'dry_run', data: [], _dryRun: true };
  assertConfigured();
  const n = Math.min(Math.max(Number(count) || 50, 1), 100);
  return request('GET', '/receive/latest', { query: { count: n }, traceId });
}

async function receiveLive({
  pageSize = 50,
  pageNumber = 1,
  sortByNewest = true,
  traceId = null,
} = {}) {
  const cfg = getConfig();
  if (cfg.dryRun) return { status: 1, message: 'dry_run', data: [], _dryRun: true };
  assertConfigured();
  return request('GET', '/receive/live', {
    query: {
      pageSize: Math.min(Math.max(Number(pageSize) || 50, 1), 100),
      pageNumber: Math.max(Number(pageNumber) || 1, 1),
      sortByNewest: Boolean(sortByNewest),
    },
    traceId,
  });
}

async function getPackStatus(packId, { traceId = null } = {}) {
  if (!packId) throw new SmsirError(400, null, 'packId is required', { traceId });
  const cfg = getConfig();
  if (cfg.dryRun) {
    return { status: 1, message: 'dry_run', data: [], _dryRun: true, packId: String(packId) };
  }
  assertConfigured();
  return request('GET', `/send/pack/${encodeURIComponent(String(packId))}`, { traceId });
}

async function getSendStatus(messageId, { traceId = null } = {}) {
  if (messageId == null || messageId === '') {
    throw new SmsirError(400, null, 'messageId is required', { traceId });
  }
  const cfg = getConfig();
  if (cfg.dryRun) {
    return { status: 1, message: 'dry_run', data: null, _dryRun: true };
  }
  assertConfigured();
  return request('GET', `/send/${encodeURIComponent(String(messageId))}`, { traceId });
}

module.exports = {
  SmsirError,
  getConfig,
  isConfigured,
  sanitizeForLog,
  sendLikeToLike,
  sendBulk,
  receiveLatest,
  receiveLive,
  getPackStatus,
  getSendStatus,
};
