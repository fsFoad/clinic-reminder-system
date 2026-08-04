'use strict';

const { query } = require('../pool');

async function create(
  { appointmentId = null, eventType, details = null, userId },
  client = null
) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `INSERT INTO activity_log (appointment_id, event_type, details, user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [appointmentId, eventType, details, String(userId)]
  );
  return rows[0];
}

async function findById(id) {
  const { rows } = await query(`SELECT * FROM activity_log WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findByAppointmentId(appointmentId, { limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT *
     FROM activity_log
     WHERE appointment_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [appointmentId, limit]
  );
  return rows;
}

async function findByEventType(eventType, { userId = null, limit = 100, offset = 0 } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `SELECT *
       FROM activity_log
       WHERE user_id = $1 AND event_type = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3 OFFSET $4`,
      [String(userId), eventType, limit, offset]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT *
     FROM activity_log
     WHERE event_type = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [eventType, limit, offset]
  );
  return rows;
}

async function findRecent({ userId = null, limit = 50 } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `SELECT *
       FROM activity_log
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [String(userId), limit]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT *
     FROM activity_log
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function findAlerts({ userId = null, limit = 50 } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `SELECT *
       FROM activity_log
       WHERE user_id = $1
         AND event_type IN ('no_response_alert', 'fallback_triggered', 'manual_override')
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [String(userId), limit]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT *
     FROM activity_log
     WHERE event_type IN ('no_response_alert', 'fallback_triggered', 'manual_override')
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function remove(id) {
  const { rows } = await query(`DELETE FROM activity_log WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}

module.exports = {
  create,
  findById,
  findByAppointmentId,
  findByEventType,
  findRecent,
  findAlerts,
  remove,
};
