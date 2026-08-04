'use strict';

/**
 * Poll SMS.ir inbox (no webhook) and feed replies into inboundService.
 * Optionally refresh outbound delivery_status via pack reports.
 */

const db = require('../../db');
const smsir = require('../channels/smsir');
const inboundService = require('./inboundService');
const { DELIVERY_STATUS, EVENT_TYPE } = require('../constants');
const { log, newTraceId } = require('../utils/log');

function envFlag(name, defaultTrue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultTrue;
  return ['1', 'true', 'yes'].includes(String(raw).toLowerCase());
}

function pollEnabled() {
  return envFlag('SMSIR_POLL_ENABLED', true) && smsir.isConfigured();
}

function deliveryPollEnabled() {
  return envFlag('SMSIR_DELIVERY_POLL_ENABLED', true);
}

/**
 * Map SMS.ir DeliveryState byte → our delivery_status.
 * Documented sample uses 1 for successful handset delivery.
 */
function mapDeliveryState(state) {
  if (state == null || state === '') return null;
  const n = Number(state);
  if (n === 1) return DELIVERY_STATUS.DELIVERED;
  if (n === 2 || n === 3 || n === 5 || n === 8 || n === 9) return DELIVERY_STATUS.FAILED;
  return null;
}

async function processInboundLatest({ count = 50 } = {}) {
  if (!smsir.isConfigured() && !smsir.getConfig().dryRun) {
    return { ok: false, error: 'smsir_not_configured', processed: 0, results: [] };
  }

  const response = await smsir.receiveLatest({ count });
  const items = Array.isArray(response?.data) ? response.data : [];
  const results = [];

  for (const item of items) {
    const mobile = item.mobile ?? item.Mobile;
    const content = item.messageText ?? item.MessageText ?? '';
    const receiveId = item.receiveReturnId ?? item.ReceiveReturnId ?? null;

    try {
      const handled = await inboundService.handleInboundMessage({
        channel: 'sms',
        externalId: mobile != null ? String(mobile) : '',
        content: String(content),
        providerMessageId: receiveId != null ? String(receiveId) : null,
      });
      results.push({
        receiveId,
        mobile: mobile != null ? String(mobile) : null,
        ok: handled.ok,
        duplicate: Boolean(handled.duplicate),
        error: handled.error || null,
        intent: handled.parsed?.intent || null,
        appointmentId: handled.appointment?.id || null,
      });
    } catch (err) {
      results.push({
        receiveId,
        mobile: mobile != null ? String(mobile) : null,
        ok: false,
        error: err.message || String(err),
      });
    }
  }

  return {
    ok: true,
    dryRun: Boolean(response?._dryRun),
    fetched: items.length,
    processed: results.filter((r) => r.ok && !r.duplicate).length,
    duplicates: results.filter((r) => r.duplicate).length,
    results,
  };
}

async function processPackDeliveryUpdates({ limit = 40 } = {}) {
  if (!deliveryPollEnabled()) {
    return { ok: true, skipped: true, reason: 'delivery_poll_disabled', updated: 0 };
  }
  if (!smsir.isConfigured() && !smsir.getConfig().dryRun) {
    return { ok: false, error: 'smsir_not_configured', updated: 0 };
  }

  const rows = await db.messages.listAwaitingSmsDelivery({ limit });
  const byPack = new Map();
  for (const row of rows) {
    const packId = row.provider_pack_id;
    if (!packId) continue;
    if (!byPack.has(packId)) byPack.set(packId, []);
    byPack.get(packId).push(row);
  }

  let updated = 0;
  const details = [];

  for (const [packId, packRows] of byPack) {
    const packTrace =
      (packRows[0] && packRows[0].trace_id) || newTraceId();
    log.info({
      traceId: packTrace,
      step: 'delivery_poll_pack',
      packId,
      rowCount: packRows.length,
    });
    let report;
    try {
      report = await smsir.getPackStatus(packId, { traceId: packTrace });
    } catch (err) {
      log.error({
        traceId: packTrace,
        step: 'delivery_poll_pack_error',
        packId,
        error: err.message || String(err),
        smsirStatus: err.smsirStatus != null ? err.smsirStatus : null,
      });
      details.push({ packId, error: err.message || String(err), traceId: packTrace });
      continue;
    }

    const items = Array.isArray(report?.data) ? report.data : [];
    for (const item of items) {
      const messageId = item.messageId ?? item.MessageId;
      if (messageId == null) continue;
      const status = mapDeliveryState(item.deliveryState ?? item.DeliveryState);
      log.info({
        traceId: packTrace,
        step: 'delivery_poll_item',
        packId,
        providerMessageId: String(messageId),
        deliveryState: item.deliveryState ?? item.DeliveryState ?? null,
        mappedStatus: status,
      });
      if (!status) continue;

      const local =
        packRows.find((r) => String(r.provider_message_id) === String(messageId)) ||
        (await db.messages.findByProviderMessageId(String(messageId)));
      if (!local) continue;
      if (local.delivery_status === status) continue;

      const deliveredAt =
        status === DELIVERY_STATUS.DELIVERED
          ? item.deliveryDateTime || item.DeliveryDateTime
            ? new Date(Number(item.deliveryDateTime || item.DeliveryDateTime) * 1000).toISOString()
            : new Date().toISOString()
          : null;

      await db.messages.updateDeliveryStatus(local.id, status, { deliveredAt });
      await db.activityLog.create({
        appointmentId: local.appointment_id,
        eventType: EVENT_TYPE.WEBHOOK_RECEIVED,
        details: {
          source: 'smsir_pack_poll',
          trace_id: packTrace,
          provider_message_id: String(messageId),
          provider_pack_id: packId,
          delivery_status: status,
          delivery_state: item.deliveryState ?? item.DeliveryState,
        },
        userId: String(local.user_id),
      });
      updated += 1;
      details.push({
        messageId: local.id,
        providerMessageId: String(messageId),
        deliveryStatus: status,
        traceId: packTrace,
      });
    }
  }

  return { ok: true, packs: byPack.size, scanned: rows.length, updated, details };
}

async function pollOnce() {
  const inbound = await processInboundLatest();
  const delivery = await processPackDeliveryUpdates();
  return { inbound, delivery };
}

module.exports = {
  pollEnabled,
  processInboundLatest,
  processPackDeliveryUpdates,
  pollOnce,
  mapDeliveryState,
};
