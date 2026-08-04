'use strict';

const { query } = require('../pool');

async function create(
  {
    appointmentId,
    channel,
    direction,
    content,
    providerMessageId = null,
    providerPackId = null,
    deliveryStatus = 'pending',
    note = null,
    sentAt = null,
    deliveredAt = null,
    userId,
  },
  client = null
) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `INSERT INTO messages
       (appointment_id, channel, direction, content, provider_message_id,
        provider_pack_id, delivery_status, note, sent_at, delivered_at, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      appointmentId,
      channel,
      direction,
      content,
      providerMessageId,
      providerPackId,
      deliveryStatus,
      note,
      sentAt,
      deliveredAt,
      String(userId),
    ]
  );
  return rows[0];
}

async function findById(id, { userId = null } = {}) {
  if (userId != null) {
    const { rows } = await query(`SELECT * FROM messages WHERE id = $1 AND user_id = $2`, [
      id,
      String(userId),
    ]);
    return rows[0] || null;
  }
  const { rows } = await query(`SELECT * FROM messages WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findByAppointmentId(appointmentId, { userId = null } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `SELECT *
       FROM messages
       WHERE appointment_id = $1 AND user_id = $2
       ORDER BY created_at, id`,
      [appointmentId, String(userId)]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT *
     FROM messages
     WHERE appointment_id = $1
     ORDER BY created_at, id`,
    [appointmentId]
  );
  return rows;
}

async function findByProviderMessageId(providerMessageId) {
  const { rows } = await query(
    `SELECT *
     FROM messages
     WHERE provider_message_id = $1
     LIMIT 1`,
    [providerMessageId]
  );
  return rows[0] || null;
}

async function update(id, fields) {
  const map = {
    content: 'content',
    providerMessageId: 'provider_message_id',
    providerPackId: 'provider_pack_id',
    deliveryStatus: 'delivery_status',
    note: 'note',
    sentAt: 'sent_at',
    deliveredAt: 'delivered_at',
  };

  const sets = [];
  const values = [id];

  for (const [camel, column] of Object.entries(map)) {
    if (fields[camel] !== undefined) {
      values.push(fields[camel]);
      sets.push(`${column} = $${values.length}`);
    } else if (fields[column] !== undefined) {
      values.push(fields[column]);
      sets.push(`${column} = $${values.length}`);
    }
  }

  if (sets.length === 0) {
    return findById(id);
  }

  const { rows } = await query(
    `UPDATE messages
     SET ${sets.join(', ')}
     WHERE id = $1
     RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function updateDeliveryStatus(id, deliveryStatus, { deliveredAt = null, sentAt = null } = {}) {
  const { rows } = await query(
    `UPDATE messages
     SET
       delivery_status = $2,
       sent_at = COALESCE($3, sent_at),
       delivered_at = COALESCE($4, delivered_at)
     WHERE id = $1
     RETURNING *`,
    [id, deliveryStatus, sentAt, deliveredAt]
  );
  return rows[0] || null;
}

async function remove(id) {
  const { rows } = await query(`DELETE FROM messages WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}

async function findLatestOutbound(appointmentId) {
  const { rows } = await query(
    `SELECT *
     FROM messages
     WHERE appointment_id = $1
       AND direction = 'outbound'
     ORDER BY COALESCE(sent_at, created_at) DESC, id DESC
     LIMIT 1`,
    [appointmentId]
  );
  return rows[0] || null;
}

async function findLatestInbound(appointmentId) {
  const { rows } = await query(
    `SELECT *
     FROM messages
     WHERE appointment_id = $1
       AND direction = 'inbound'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [appointmentId]
  );
  return rows[0] || null;
}

async function findPendingOutbound({ userId = null, limit = 50 } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `SELECT *
       FROM messages
       WHERE user_id = $1
         AND direction = 'outbound'
         AND delivery_status = 'pending'
       ORDER BY created_at
       LIMIT $2`,
      [String(userId), limit]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT *
     FROM messages
     WHERE direction = 'outbound'
       AND delivery_status = 'pending'
     ORDER BY created_at
     LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Match an inbound webhook/chat message to the most recent open appointment
 * for the patient identified by channel + external_id.
 */
async function findLatestPendingByPatient(patientId) {
  const { rows } = await query(
    `SELECT m.*
     FROM messages m
     JOIN appointments a ON a.id = m.appointment_id
     WHERE a.patient_id = $1
       AND a.status = 'scheduled'
       AND m.direction = 'outbound'
     ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
     LIMIT 1`,
    [patientId]
  );
  return rows[0] || null;
}

/** Outbound reminder sends for the reminders log UI. */
async function listOutboundReminders({ userId, limit = 200, offset = 0, channel = null } = {}) {
  const params = [String(userId)];
  let channelFilter = '';
  if (channel) {
    params.push(channel);
    channelFilter = `AND m.channel = $${params.length}`;
  }
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const { rows } = await query(
    `SELECT
       m.id AS message_id,
       m.appointment_id,
       a.patient_id,
       p.name AS patient_name,
       a.appointment_date,
       a.appointment_time,
       a.visit_type,
       a.status AS appointment_status,
       m.channel,
       m.delivery_status,
       m.note,
       m.content,
       m.provider_message_id,
       m.provider_pack_id,
       m.sent_at,
       m.delivered_at,
       m.created_at
     FROM messages m
     JOIN appointments a ON a.id = m.appointment_id AND a.user_id = m.user_id
     JOIN patients p ON p.id = a.patient_id AND p.user_id = m.user_id
     WHERE m.user_id = $1
       AND m.direction = 'outbound'
       ${channelFilter}
     ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );
  return rows;
}

async function existsWithNote(appointmentId, note) {
  const { rows } = await query(
    `SELECT 1
     FROM messages
     WHERE appointment_id = $1
       AND note = $2
     LIMIT 1`,
    [appointmentId, note]
  );
  return rows.length > 0;
}

/** Outbound SMS rows waiting for delivery confirmation (have pack id, still `sent`). */
async function listAwaitingSmsDelivery({ limit = 40 } = {}) {
  const { rows } = await query(
    `SELECT *
     FROM messages
     WHERE channel = 'sms'
       AND direction = 'outbound'
       AND delivery_status = 'sent'
       AND provider_pack_id IS NOT NULL
       AND provider_message_id IS NOT NULL
     ORDER BY COALESCE(sent_at, created_at) ASC, id ASC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = {
  create,
  findById,
  findByAppointmentId,
  findByProviderMessageId,
  update,
  updateDeliveryStatus,
  remove,
  findLatestOutbound,
  findLatestInbound,
  findPendingOutbound,
  findLatestPendingByPatient,
  listOutboundReminders,
  existsWithNote,
  listAwaitingSmsDelivery,
};
