'use strict';

const CHANNELS = Object.freeze(['sms', 'bale', 'whatsapp', 'telegram']);

const APPOINTMENT_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  CONFIRMED: 'confirmed',
  RESCHEDULED: 'rescheduled',
  CANCELLED: 'cancelled',
  NEEDS_REVIEW: 'needs_review',
  NO_RESPONSE: 'no_response',
});

const DIRECTION = Object.freeze({
  OUTBOUND: 'outbound',
  INBOUND: 'inbound',
});

const DELIVERY_STATUS = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  FAILED: 'failed',
});

const EVENT_TYPE = Object.freeze({
  NO_RESPONSE_ALERT: 'no_response_alert',
  FALLBACK_TRIGGERED: 'fallback_triggered',
  MANUAL_OVERRIDE: 'manual_override',
  WEBHOOK_RECEIVED: 'webhook_received',
  REMINDER_SENT: 'reminder_sent',
  RESPONSE_PARSED: 'response_parsed',
});

/** Default hours to wait on preferred channel before SMS fallback */
const DEFAULT_FALLBACK_HOURS = Number(process.env.FALLBACK_HOURS || 4);

module.exports = {
  CHANNELS,
  APPOINTMENT_STATUS,
  DIRECTION,
  DELIVERY_STATUS,
  EVENT_TYPE,
  DEFAULT_FALLBACK_HOURS,
};
