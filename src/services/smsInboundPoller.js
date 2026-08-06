'use strict';

/**
 * Poll SMS.ir inbox (no webhook) and feed replies into inboundService.
 * Optionally refresh outbound delivery_status via pack reports.
 */

const db = require('../../db');
const smsir = require('../channels/smsir');
const inboundService = require('./inboundService');
const realtime = require('../realtime/hub');
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
 * Map SMS.ir DeliveryState → our delivery_status.
 * Official table (sms.ir/rest-api «کدهای وضعیت دلیوری»):
 * 1 delivered · 2 not to handset · 3 telecom processing · 4 not to telecom ·
 * 5 reached telecom · 6 error · 7 blacklist.
 * In-transit (3, 5) stay null so we keep polling; terminal failures update to failed.
 */
function mapDeliveryState(state) {
  if (state == null || state === '') return null;
  const n = Number(state);
  if (n === 1) return DELIVERY_STATUS.DELIVERED;
  if (n === 2 || n === 4 || n === 6 || n === 7) return DELIVERY_STATUS.FAILED;
  return null;
}

function normalizeInboxItem(item) {
  const mobile = item.mobile ?? item.Mobile;
  const content = item.messageText ?? item.MessageText ?? '';
  const receiveId = item.receiveReturnId ?? item.ReceiveReturnId ?? null;
  return {
    mobile: mobile != null ? String(mobile) : null,
    content: String(content),
    receiveId: receiveId != null ? String(receiveId) : null,
  };
}

async function handleInboxItems(items, { source } = {}) {
  const results = [];
  const seen = new Set();

  for (const raw of items) {
    const item = normalizeInboxItem(raw);
    if (item.receiveId) {
      if (seen.has(item.receiveId)) continue;
      seen.add(item.receiveId);
    }

    try {
      const handled = await inboundService.handleInboundMessage({
        channel: 'sms',
        externalId: item.mobile || '',
        content: item.content,
        providerMessageId: item.receiveId,
      });
      results.push({
        source: source || null,
        receiveId: item.receiveId,
        mobile: item.mobile,
        ok: handled.ok,
        duplicate: Boolean(handled.duplicate),
        error: handled.error || null,
        intent: handled.parsed?.intent || null,
        appointmentId: handled.appointment?.id || null,
      });
    } catch (err) {
      results.push({
        source: source || null,
        receiveId: item.receiveId,
        mobile: item.mobile,
        ok: false,
        error: err.message || String(err),
      });
    }
  }

  return results;
}

/**
 * Prefer receive/latest (unread, one-shot). Also sweep receive/live so
 * messages already marked-read in the SMS.ir panel (or missed between polls)
 * still land in our DB via provider_message_id dedupe.
 */
async function processInboundLatest({ count = 50 } = {}) {
  if (!smsir.isConfigured() && !smsir.getConfig().dryRun) {
    return { ok: false, error: 'smsir_not_configured', processed: 0, results: [] };
  }

  const latestResponse = await smsir.receiveLatest({ count });
  const latestItems = Array.isArray(latestResponse?.data) ? latestResponse.data : [];

  let liveItems = [];
  let liveDryRun = false;
  try {
    const liveResponse = await smsir.receiveLive({
      pageSize: Math.min(Math.max(Number(count) || 50, 1), 100),
      pageNumber: 1,
      sortByNewest: true,
    });
    liveDryRun = Boolean(liveResponse?._dryRun);
    liveItems = Array.isArray(liveResponse?.data) ? liveResponse.data : [];
  } catch (err) {
    log.warn({
      step: 'smsir_receive_live_failed',
      error: err.message || String(err),
      smsirStatus: err.smsirStatus != null ? err.smsirStatus : null,
    });
  }

  const latestResults = await handleInboxItems(latestItems, { source: 'latest' });
  const liveResults = await handleInboxItems(liveItems, { source: 'live' });
  const results = [...latestResults, ...liveResults];

  return {
    ok: true,
    dryRun: Boolean(latestResponse?._dryRun) || liveDryRun,
    fetched: latestItems.length + liveItems.length,
    fetchedLatest: latestItems.length,
    fetchedLive: liveItems.length,
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
      const deliveryStateRaw = item.deliveryState ?? item.DeliveryState;
      const deliveryState =
        deliveryStateRaw == null || deliveryStateRaw === ''
          ? null
          : Number(deliveryStateRaw);
      const status = mapDeliveryState(deliveryStateRaw);
      log.info({
        traceId: packTrace,
        step: 'delivery_poll_item',
        packId,
        providerMessageId: String(messageId),
        deliveryState: deliveryStateRaw ?? null,
        mappedStatus: status,
      });

      const local =
        packRows.find((r) => String(r.provider_message_id) === String(messageId)) ||
        (await db.messages.findByProviderMessageId(String(messageId)));
      if (!local) continue;

      const sameStatus = status == null || local.delivery_status === status;
      const sameState =
        deliveryState == null ||
        Number(local.provider_delivery_state) === deliveryState;
      if (sameStatus && sameState) continue;
      // In-transit (3/5) has no mapped status — still persist delivery_state and keep polling.
      if (!status && deliveryState == null) continue;

      const nextStatus = status || local.delivery_status;
      const deliveredAt =
        nextStatus === DELIVERY_STATUS.DELIVERED
          ? item.deliveryDateTime || item.DeliveryDateTime
            ? new Date(Number(item.deliveryDateTime || item.DeliveryDateTime) * 1000).toISOString()
            : new Date().toISOString()
          : null;

      await db.messages.updateDeliveryStatus(local.id, nextStatus, {
        deliveredAt,
        providerDeliveryState: deliveryState,
      });
      await db.activityLog.create({
        appointmentId: local.appointment_id,
        eventType: EVENT_TYPE.WEBHOOK_RECEIVED,
        details: {
          source: 'smsir_pack_poll',
          trace_id: packTrace,
          provider_message_id: String(messageId),
          provider_pack_id: packId,
          delivery_status: nextStatus,
          delivery_state: deliveryState,
        },
        userId: String(local.user_id),
      });
      try {
        realtime.broadcast(
          'delivery_status',
          {
            appointmentId: local.appointment_id,
            messageId: local.id,
            deliveryStatus: nextStatus,
            deliveryState,
          },
          { userId: String(local.user_id) },
        );
      } catch (_e) {
        /* realtime is best-effort */
      }
      updated += 1;
      details.push({
        messageId: local.id,
        providerMessageId: String(messageId),
        deliveryStatus: nextStatus,
        deliveryState,
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
