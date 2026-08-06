'use strict';

const db = require('../../db');
const {
  APPOINTMENT_STATUS,
  DIRECTION,
  DELIVERY_STATUS,
  EVENT_TYPE,
  DEFAULT_FALLBACK_HOURS,
} = require('../constants');
const { buildReminderMessage } = require('./messageTemplate');
const { sendOnChannel } = require('../channels');
const clinicSettings = require('./clinicSettings');
const { log, newTraceId, maskMobile } = require('../utils/log');

async function resolveSendTarget(patientId, preferredChannel = null) {
  if (preferredChannel) {
    const identity = await db.patients.findPreferredChannel(patientId, preferredChannel);
    if (identity) return identity;
  }
  return db.patients.findPreferredChannel(patientId);
}

/**
 * Send a reminder for an appointment on the patient's preferred (or forced) channel.
 * Uses the appointment owner's message template (or explicit userId).
 */
async function sendReminder(
  appointmentId,
  { channel = null, note = null, userId = null, traceId = null } = {}
) {
  const tid = traceId || newTraceId();

  log.info({
    traceId: tid,
    step: 'remind_start',
    appointmentId,
    userId: userId != null ? String(userId) : null,
    channelForced: channel || null,
  });

  const appointment = userId
    ? await db.appointments.findById(appointmentId, { userId })
    : await db.appointments.findById(appointmentId);
  if (!appointment) {
    const err = new Error(`Appointment ${appointmentId} not found`);
    err.status = 404;
    err.code = 'appointment_not_found';
    err.traceId = tid;
    throw err;
  }

  const ownerId = String(appointment.user_id);
  if (userId != null && String(userId) !== ownerId) {
    const err = new Error(`Appointment ${appointmentId} not found`);
    err.status = 404;
    err.code = 'appointment_not_found';
    err.traceId = tid;
    throw err;
  }

  const identity = await resolveSendTarget(appointment.patient_id, channel);
  if (!identity) {
    const err = new Error(`No channel identity for patient ${appointment.patient_id}`);
    err.status = 404;
    err.code = 'channel_missing';
    err.traceId = tid;
    throw err;
  }

  log.info({
    traceId: tid,
    step: 'remind_identity_resolved',
    appointmentId,
    patientId: appointment.patient_id,
    channel: identity.channel,
    mobileMasked: maskMobile(identity.external_id),
  });

  const content = await buildReminderMessage(ownerId, {
    visitType: appointment.visit_type,
    appointmentDate: appointment.appointment_date,
    appointmentTime: appointment.appointment_time,
    channel: identity.channel,
  });

  log.info({
    traceId: tid,
    step: 'remind_message_built',
    appointmentId,
    channel: identity.channel,
    messageTextLen: content != null ? String(content).length : 0,
  });

  const message = await db.messages.create({
    appointmentId,
    channel: identity.channel,
    direction: DIRECTION.OUTBOUND,
    content,
    deliveryStatus: DELIVERY_STATUS.PENDING,
    note,
    userId: ownerId,
  });

  const attempt = await db.reminderAttempts.createNext({
    appointmentId,
    channel: identity.channel,
    userId: ownerId,
  });

  log.info({
    traceId: tid,
    step: 'remind_db_pending',
    appointmentId,
    messageId: message.id,
    attemptId: attempt.id,
    deliveryStatus: DELIVERY_STATUS.PENDING,
  });

  try {
    const result = await sendOnChannel(identity.channel, {
      to: identity.external_id,
      content,
      traceId: tid,
    });

    // SMS: never mark sent on dry-run leak or missing provider id.
    if (identity.channel === 'sms') {
      const smsir = require('../channels/smsir');
      if (result.dryRun && !smsir.getConfig().dryRun) {
        const err = new Error(
          'SMS dry-run / fake provider response while SMSIR_DRY_RUN=false — not marked sent'
        );
        err.status = 502;
        err.code = 'smsir_dry_run_leak';
        err.traceId = tid;
        throw err;
      }
      if (!result.providerMessageId) {
        const err = new Error('SMS provider returned no messageId');
        err.status = 502;
        err.code = 'smsir_no_message_id';
        err.traceId = tid;
        throw err;
      }
    }

    const sentAt = new Date().toISOString();
    const updated = await db.messages.updateDeliveryStatus(message.id, DELIVERY_STATUS.SENT, {
      sentAt,
    });
    await db.messages.update(message.id, {
      providerMessageId: result.providerMessageId,
      providerPackId: result.providerPackId || null,
    });

    await db.activityLog.create({
      appointmentId,
      eventType: EVENT_TYPE.REMINDER_SENT,
      details: {
        trace_id: tid,
        channel: identity.channel,
        external_id: identity.external_id,
        message_id: message.id,
        attempt_id: attempt.id,
        provider_message_id: result.providerMessageId,
        provider_pack_id: result.providerPackId || null,
        dry_run: Boolean(result.dryRun),
        note,
      },
      userId: ownerId,
    });

    log.info({
      traceId: tid,
      step: 'remind_db_sent',
      appointmentId,
      messageId: message.id,
      attemptId: attempt.id,
      providerMessageId: result.providerMessageId,
      providerPackId: result.providerPackId || null,
      deliveryStatus: DELIVERY_STATUS.SENT,
      dryRun: Boolean(result.dryRun),
    });

    return {
      traceId: tid,
      appointment,
      identity,
      message: {
        ...updated,
        provider_message_id: result.providerMessageId,
        provider_pack_id: result.providerPackId || null,
      },
      attempt,
      dryRun: Boolean(result.dryRun),
    };
  } catch (err) {
    await db.messages.updateDeliveryStatus(message.id, DELIVERY_STATUS.FAILED);
    err.traceId = err.traceId || tid;
    log.error({
      traceId: tid,
      step: 'remind_failed',
      appointmentId,
      messageId: message.id,
      code: err.code || null,
      smsirStatus: err.smsirStatus != null ? err.smsirStatus : null,
      error: err.message || String(err),
      stack: err.stack,
    });
    throw err;
  }
}

/**
 * If Bale (or preferred non-SMS) went unanswered past threshold, send SMS fallback.
 */
async function maybeFallbackToSms(appointmentId, { hours = DEFAULT_FALLBACK_HOURS, userId } = {}) {
  const appointment = await db.appointments.findById(appointmentId, { userId });
  if (!appointment || appointment.status !== APPOINTMENT_STATUS.SCHEDULED) {
    return null;
  }

  const pending = await db.appointments.findWithoutResponseOlderThan(hours, { userId });
  const row = pending.find((p) => Number(p.appointment_id) === Number(appointmentId));
  if (!row) return null;

  if (row.last_outbound_channel === 'sms') {
    return null;
  }

  const smsIdentity = await db.patients.findPreferredChannel(appointment.patient_id, 'sms');
  if (!smsIdentity) {
    await db.activityLog.create({
      appointmentId,
      eventType: EVENT_TYPE.NO_RESPONSE_ALERT,
      details: {
        reason: 'fallback_requested_but_no_sms_identity',
        hours_since_outbound: row.hours_since_outbound,
        last_channel: row.last_outbound_channel,
      },
      userId: String(userId),
    });
    return null;
  }

  await db.activityLog.create({
    appointmentId,
    eventType: EVENT_TYPE.FALLBACK_TRIGGERED,
    details: {
      from: row.last_outbound_channel,
      to: 'sms',
      hours_waited: row.hours_since_outbound,
    },
    userId: String(userId),
  });

  return sendReminder(appointmentId, {
    channel: 'sms',
    note: 'fallback_from_bale',
    userId,
  });
}

/**
 * Cron entry: process each user's unanswered appointments with THAT user's threshold.
 * @param {{ hours?: number|null }} [opts] if set, uses that threshold for all users
 */
async function processFallbacks({ hours = null } = {}) {
  const userIds = await clinicSettings.listSettingsUserIds();
  const ids = userIds.length ? userIds : [String(process.env.DEFAULT_SETTINGS_USER_ID || '1')];
  const allResults = [];

  for (const userId of ids) {
    const settings = await clinicSettings.getSettings(userId);
    const threshold =
      hours != null && Number.isFinite(Number(hours))
        ? Number(hours)
        : settings.fallbackAfterHours || DEFAULT_FALLBACK_HOURS;

    const candidates = await db.appointments.findWithoutResponseOlderThan(threshold, { userId });
    for (const row of candidates) {
      if (row.last_outbound_channel === 'sms') {
        await db.activityLog.create({
          appointmentId: row.appointment_id,
          eventType: EVENT_TYPE.NO_RESPONSE_ALERT,
          details: {
            channels_tried: ['sms'],
            hours_since_outbound: row.hours_since_outbound,
            settings_user_id: userId,
          },
          userId,
        });
        allResults.push({
          userId,
          appointmentId: row.appointment_id,
          action: 'alert_only',
          hours: threshold,
        });
        continue;
      }

      const sent = await maybeFallbackToSms(row.appointment_id, { hours: threshold, userId });
      allResults.push({
        userId,
        appointmentId: row.appointment_id,
        action: sent ? 'fallback_sms_sent' : 'skipped',
        hours: threshold,
      });
    }
  }

  return allResults;
}

/**
 * Mark appointments that exhausted SMS fallback as no_response (optional cron).
 */
async function markNoResponseOlderThan(hours, { userId } = {}) {
  const candidates = await db.appointments.findWithoutResponseOlderThan(hours, { userId });
  const updated = [];

  for (const row of candidates) {
    if (row.last_outbound_channel !== 'sms') continue;

    const appt = await db.appointments.updateStatus(
      row.appointment_id,
      APPOINTMENT_STATUS.NO_RESPONSE,
      { userId }
    );
    await db.activityLog.create({
      appointmentId: row.appointment_id,
      eventType: EVENT_TYPE.NO_RESPONSE_ALERT,
      details: {
        action: 'status_set_no_response',
        hours_since_outbound: row.hours_since_outbound,
      },
      userId: String(userId || row.user_id),
    });
    updated.push(appt);
  }

  return updated;
}

function autoOffsetNote(offsetHours) {
  return `auto_offset_${Number(offsetHours)}`;
}

/**
 * Cron: send automatic reminders for ONE user's appointments using THAT user's
 * reminderOffsetsHours and message template.
 */
async function processDueRemindersForUser(userId, settings) {
  const offsets = (settings.reminderOffsetsHours || [])
    .map((h) => Number(h))
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => b - a);

  if (!offsets.length) {
    return { userId, offsets: [], scanned: 0, results: [] };
  }

  const maxOffset = offsets[0];
  const candidates = await db.appointments.findScheduledWithinHours(maxOffset, { userId });
  const results = [];

  for (const appt of candidates) {
    const hoursUntil = Number(appt.hours_until);
    if (!Number.isFinite(hoursUntil) || hoursUntil <= 0) continue;

    for (const offset of offsets) {
      if (hoursUntil > offset) continue;

      const note = autoOffsetNote(offset);
      const already = await db.messages.existsWithNote(appt.id, note);
      if (already) continue;

      try {
        const sent = await sendReminder(appt.id, { note, userId });
        results.push({
          userId,
          appointmentId: appt.id,
          patientId: appt.patient_id,
          offsetHours: offset,
          hoursUntil: Math.round(hoursUntil * 10) / 10,
          action: 'sent',
          channel: sent.identity?.channel,
          messageId: sent.message?.id,
          traceId: sent.traceId,
        });
      } catch (err) {
        results.push({
          userId,
          appointmentId: appt.id,
          patientId: appt.patient_id,
          offsetHours: offset,
          hoursUntil: Math.round(hoursUntil * 10) / 10,
          action: 'error',
          error: err.message || String(err),
          traceId: err.traceId || null,
        });
      }
      // One auto reminder per appointment per user tick (avoids double-SMS on catch-up).
      break;
    }
  }

  return {
    userId,
    offsets,
    scanned: candidates.length,
    sent: results.filter((r) => r.action === 'sent').length,
    errors: results.filter((r) => r.action === 'error').length,
    results,
  };
}

async function processDueReminders() {
  const userIds = await clinicSettings.listSettingsUserIds();
  const ids = userIds.length ? userIds : [String(process.env.DEFAULT_SETTINGS_USER_ID || '1')];

  const byUser = [];
  const allResults = [];
  let scanned = 0;
  let sent = 0;
  let errors = 0;
  const offsetSet = new Set();

  for (const userId of ids) {
    const settings = await clinicSettings.getSettings(userId);
    const report = await processDueRemindersForUser(userId, settings);
    byUser.push({
      userId: report.userId,
      offsets: report.offsets,
      scanned: report.scanned,
      sent: report.sent,
      errors: report.errors,
    });
    scanned += report.scanned;
    sent += report.sent;
    errors += report.errors;
    for (const o of report.offsets) offsetSet.add(o);
    allResults.push(...report.results);
  }

  return {
    users: byUser.length,
    offsets: [...offsetSet].sort((a, b) => b - a),
    scanned,
    sent,
    errors,
    byUser,
    results: allResults,
  };
}

module.exports = {
  sendReminder,
  maybeFallbackToSms,
  processFallbacks,
  markNoResponseOlderThan,
  processDueReminders,
  resolveSendTarget,
  autoOffsetNote,
};
