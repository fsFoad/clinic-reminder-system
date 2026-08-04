'use strict';



const db = require('../../db');

const {

  DIRECTION,

  DELIVERY_STATUS,

  EVENT_TYPE,

} = require('../constants');

const { parsePatientResponse } = require('./responseParser');



/**

 * Handle an inbound patient message identified by channel + external_id.

 * Matches the latest scheduled appointment for that patient (tenant from identity).

 * For SMS, externalId may be 912… / 0912… / +98912… — identity lookup normalizes variants.

 */

async function handleInboundMessage({

  channel,

  externalId,

  content,

  providerMessageId = null,

}) {

  if (providerMessageId) {

    const existing = await db.messages.findByProviderMessageId(String(providerMessageId));

    if (existing) {

      return { ok: true, duplicate: true, message: existing };

    }

  }



  const identity = await db.patientChannelIdentities.findByChannelExternalId(

    channel,

    externalId

  );

  if (!identity) {

    await db.activityLog.create({

      appointmentId: null,

      eventType: EVENT_TYPE.WEBHOOK_RECEIVED,

      details: {

        channel,

        external_id: externalId,

        error: 'unknown_identity',

        content,

      },

      userId: String(process.env.DEFAULT_SETTINGS_USER_ID || '1'),

    });

    return { ok: false, error: 'unknown_identity' };

  }



  // Multi-tenant: always use the matched identity's user_id for appointment lookup.

  const ownerId = String(identity.user_id);

  const appointment = await db.appointments.findLatestPendingByPatient(identity.patient_id, {

    userId: ownerId,

  });

  if (!appointment) {

    await db.activityLog.create({

      appointmentId: null,

      eventType: EVENT_TYPE.WEBHOOK_RECEIVED,

      details: {

        channel,

        external_id: externalId,

        patient_id: identity.patient_id,

        error: 'no_open_appointment',

        content,

      },

      userId: ownerId,

    });

    return { ok: false, error: 'no_open_appointment', patientId: identity.patient_id };

  }



  const inbound = await db.messages.create({

    appointmentId: appointment.id,

    channel,

    direction: DIRECTION.INBOUND,

    content,

    providerMessageId,

    deliveryStatus: DELIVERY_STATUS.DELIVERED,

    userId: ownerId,

  });



  const parsed = parsePatientResponse(content);

  const updated = await db.appointments.updateStatus(appointment.id, parsed.status, {

    userId: ownerId,

  });



  await db.activityLog.create({

    appointmentId: appointment.id,

    eventType: EVENT_TYPE.RESPONSE_PARSED,

    details: {

      intent: parsed.intent,

      status: parsed.status,

      normalized: parsed.normalized,

      message_id: inbound.id,

      channel,

    },

    userId: ownerId,

  });



  if (parsed.intent === 'unknown') {

    await db.activityLog.create({

      appointmentId: appointment.id,

      eventType: EVENT_TYPE.MANUAL_OVERRIDE,

      details: {

        reason: 'unparseable_response',

        raw: content,

        action: 'flagged_needs_review',

      },

      userId: ownerId,

    });

  }



  return {

    ok: true,

    appointment: updated,

    message: inbound,

    parsed,

    needsReview: parsed.intent === 'unknown',

  };

}



/**

 * Delivery webhook: update outbound message by provider_message_id.

 */

async function handleDeliveryWebhook({

  providerMessageId,

  deliveryStatus,

  deliveredAt = null,

  sentAt = null,

  raw = null,

}) {

  const message = await db.messages.findByProviderMessageId(providerMessageId);

  if (!message) {

    await db.activityLog.create({

      appointmentId: null,

      eventType: EVENT_TYPE.WEBHOOK_RECEIVED,

      details: {

        error: 'unknown_provider_message_id',

        provider_message_id: providerMessageId,

        delivery_status: deliveryStatus,

        raw,

      },

      userId: String(process.env.DEFAULT_SETTINGS_USER_ID || '1'),

    });

    return { ok: false, error: 'unknown_provider_message_id' };

  }



  const updated = await db.messages.updateDeliveryStatus(message.id, deliveryStatus, {

    deliveredAt,

    sentAt,

  });



  await db.activityLog.create({

    appointmentId: message.appointment_id,

    eventType: EVENT_TYPE.WEBHOOK_RECEIVED,

    details: {

      provider_message_id: providerMessageId,

      delivery_status: deliveryStatus,

      message_id: message.id,

    },

    userId: String(message.user_id),

  });



  return { ok: true, message: updated };

}



module.exports = {

  handleInboundMessage,

  handleDeliveryWebhook,

};


