'use strict';

/**
 * Channel adapters.
 * Contract: send({ to, content, traceId? }) => { providerMessageId, providerPackId?, raw, dryRun? }
 */

const smsir = require('./smsir');
const { toApiMobile } = require('../utils/iranMobile');
const { log, maskMobile } = require('../utils/log');

const DOCS_SAMPLE_PACK = '2b99e63c-9bf8-4a21-9bfe-3f72dc1b46f1';
const DOCS_SAMPLE_IDS = new Set([86522023, 86522024]);

function attachTrace(err, traceId) {
  if (err && traceId && !err.traceId) err.traceId = traceId;
  return err;
}

/**
 * Refuse success unless SMS.ir status===1 and a real messageId (>0) is present.
 * Also reject docs-sample packs and dry-run leaks when DRY_RUN is false.
 */
function assertRealSmsirSuccess(response, { dryRunAllowed, traceId }) {
  const status = Number(response?.status ?? response?.Status);
  if (status !== 1) {
    const err = new Error(
      `SMS.ir status was ${Number.isFinite(status) ? status : 'missing'}; expected 1`
    );
    err.status = 502;
    err.code = 'smsir_bad_status';
    err.smsirStatus = Number.isFinite(status) ? status : null;
    err.raw = smsir.sanitizeForLog(response);
    throw attachTrace(err, traceId);
  }

  const data = response?.data || {};
  const messageIds = Array.isArray(data.messageIds)
    ? data.messageIds
    : Array.isArray(data.MessageIds)
      ? data.MessageIds
      : [];
  const messageId = messageIds[0];
  const packId = data.packId || data.PackId || null;
  const isDry = Boolean(response?._dryRun);

  if (isDry && !dryRunAllowed) {
    const err = new Error(
      'SMS.ir dry-run response received while SMSIR_DRY_RUN is false — refusing fake success'
    );
    err.status = 502;
    err.code = 'smsir_dry_run_leak';
    err.raw = smsir.sanitizeForLog(response);
    throw attachTrace(err, traceId);
  }

  if (!isDry && packId != null && String(packId).startsWith('dry-pack-')) {
    const err = new Error('Refusing dry-pack id while not in dry-run mode');
    err.status = 502;
    err.code = 'smsir_dry_pack';
    err.raw = smsir.sanitizeForLog(response);
    throw attachTrace(err, traceId);
  }

  const looksLikeDocsSample =
    String(packId || '') === DOCS_SAMPLE_PACK ||
    DOCS_SAMPLE_IDS.has(Number(messageId)) ||
    (messageIds.length >= 2 &&
      messageIds.every((id) => DOCS_SAMPLE_IDS.has(Number(id))));
  if (looksLikeDocsSample) {
    const err = new Error(
      'SMS.ir پاسخ نمونهٔ مستندات برگرداند؛ پیامک واقعی ارسال نشد. کلید API، فعال‌سازی خط و اعتبار پنل را در sms.ir بررسی کنید.'
    );
    err.status = 502;
    err.code = 'smsir_docs_sample';
    err.raw = smsir.sanitizeForLog(response);
    throw attachTrace(err, traceId);
  }

  if (messageId === 0 || messageId === '0') {
    const err = new Error('SMS.ir rejected recipient (blacklist / promotional line restriction)');
    err.status = 400;
    err.code = 'smsir_blacklist';
    err.raw = smsir.sanitizeForLog(response);
    throw attachTrace(err, traceId);
  }

  const numericId = Number(messageId);
  if (messageId == null || messageId === '' || !Number.isFinite(numericId) || numericId <= 0) {
    const err = new Error('SMS.ir rejected send (missing/invalid messageId)');
    err.status = 400;
    err.code = 'smsir_invalid';
    err.raw = smsir.sanitizeForLog(response);
    throw attachTrace(err, traceId);
  }

  if (!isDry && (packId == null || String(packId).trim() === '')) {
    const err = new Error('SMS.ir response missing packId');
    err.status = 502;
    err.code = 'smsir_no_pack';
    err.raw = smsir.sanitizeForLog(response);
    throw attachTrace(err, traceId);
  }

  return {
    messageId: String(messageId),
    packId: packId != null ? String(packId) : null,
    cost: data.cost ?? data.Cost ?? null,
    messageIds,
    isDry,
  };
}

async function sendSms({ to, content, traceId = null } = {}) {
  const mobile = toApiMobile(to);
  if (!mobile) {
    const err = new Error(`Invalid Iranian mobile for SMS.ir: ${String(to || '').slice(0, 32)}`);
    err.status = 400;
    throw attachTrace(err, traceId);
  }

  const cfg = smsir.getConfig();
  if (!smsir.isConfigured() && !cfg.dryRun) {
    const err = new Error('SMS.ir is not configured (set SMSIR_API_KEY and SMSIR_LINE_NUMBER)');
    err.status = 500;
    throw attachTrace(err, traceId);
  }

  log.info({
    traceId,
    step: 'channel_sms_send_start',
    method: 'likeToLike',
    mobileMasked: maskMobile(to),
    apiMobileFormat: mobile,
    messageTextLen: content != null ? String(content).length : 0,
    dryRun: cfg.dryRun,
    lineNumber: cfg.lineNumber || null,
    baseUrl: cfg.baseUrl,
  });

  // Official remind path: POST /send/likeToLike (parallel messageTexts ↔ mobiles).
  const response = await smsir.sendLikeToLike({
    messageTexts: [String(content)],
    mobiles: [mobile],
    sendDateTime: null,
    traceId,
  });

  let validated;
  try {
    validated = assertRealSmsirSuccess(response, {
      dryRunAllowed: cfg.dryRun,
      traceId,
    });
  } catch (err) {
    log.error({
      traceId,
      step: 'channel_sms_reject_fake_or_invalid',
      code: err.code,
      message: err.message,
      raw: err.raw || null,
    });
    throw err;
  }

  log.info({
    traceId,
    step: 'channel_sms_accepted',
    providerMessageId: validated.messageId,
    providerPackId: validated.packId,
    cost: validated.cost,
    dryRun: validated.isDry,
    smsirStatus: 1,
  });

  return {
    providerMessageId: validated.messageId,
    providerPackId: validated.packId,
    cost: validated.cost,
    dryRun: validated.isDry,
    raw: smsir.sanitizeForLog({
      status: response.status,
      message: response.message,
      data: {
        packId: validated.packId,
        messageIds: validated.messageIds,
        cost: validated.cost,
      },
      dryRun: validated.isDry,
    }),
  };
}

async function sendBale({ to, content, traceId = null } = {}) {
  log.warn({
    traceId,
    step: 'channel_bale_stub',
    toMasked: maskMobile(to),
    messageTextLen: content != null ? String(content).length : 0,
  });
  return {
    providerMessageId: `bale-stub-${Date.now()}`,
    dryRun: true,
    raw: { stub: true, to: maskMobile(to), contentLength: content.length },
  };
}

const adapters = {
  sms: sendSms,
  bale: sendBale,
};

async function sendOnChannel(channel, { to, content, traceId = null }) {
  const adapter = adapters[channel];
  if (!adapter) {
    const err = new Error(`Unsupported channel: ${channel}`);
    throw attachTrace(err, traceId);
  }
  return adapter({ to, content, traceId });
}

module.exports = {
  sendSms,
  sendBale,
  sendOnChannel,
  assertRealSmsirSuccess,
};
