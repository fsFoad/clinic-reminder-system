'use strict';

const { query } = require('../pool');

async function create(
  { appointmentId, attemptNumber = 1, channel, attemptedAt = null, userId },
  client = null
) {
  const q = client ? client.query.bind(client) : query;
  const uid = String(userId);

  if (attemptedAt) {
    const { rows } = await q(
      `INSERT INTO reminder_attempts
         (appointment_id, attempt_number, channel, attempted_at, user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [appointmentId, attemptNumber, channel, attemptedAt, uid]
    );
    return rows[0];
  }

  const { rows } = await q(
    `INSERT INTO reminder_attempts
       (appointment_id, attempt_number, channel, user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [appointmentId, attemptNumber, channel, uid]
  );
  return rows[0];
}

async function findById(id) {
  const { rows } = await query(`SELECT * FROM reminder_attempts WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findByAppointmentId(appointmentId) {
  const { rows } = await query(
    `SELECT *
     FROM reminder_attempts
     WHERE appointment_id = $1
     ORDER BY attempt_number, id`,
    [appointmentId]
  );
  return rows;
}

async function findLatestByAppointment(appointmentId) {
  const { rows } = await query(
    `SELECT *
     FROM reminder_attempts
     WHERE appointment_id = $1
     ORDER BY attempt_number DESC, id DESC
     LIMIT 1`,
    [appointmentId]
  );
  return rows[0] || null;
}

/** Next attempt_number for this appointment (max + 1, or 1 if none). */
async function nextAttemptNumber(appointmentId) {
  const { rows } = await query(
    `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_number
     FROM reminder_attempts
     WHERE appointment_id = $1`,
    [appointmentId]
  );
  return rows[0].next_number;
}

async function createNext({ appointmentId, channel, userId }, client = null) {
  const attemptNumber = await nextAttemptNumber(appointmentId);
  return create({ appointmentId, attemptNumber, channel, userId }, client);
}

async function remove(id) {
  const { rows } = await query(`DELETE FROM reminder_attempts WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}

async function countByAppointment(appointmentId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count
     FROM reminder_attempts
     WHERE appointment_id = $1`,
    [appointmentId]
  );
  return rows[0].count;
}

module.exports = {
  create,
  findById,
  findByAppointmentId,
  findLatestByAppointment,
  nextAttemptNumber,
  createNext,
  remove,
  countByAppointment,
};
