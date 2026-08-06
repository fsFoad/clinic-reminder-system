'use strict';

const { query } = require('../pool');

async function create(
  {
    patientId,
    appointmentDate,
    appointmentTime,
    visitType = null,
    status = 'scheduled',
    userId,
  },
  client = null
) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `INSERT INTO appointments
       (patient_id, appointment_date, appointment_time, visit_type, status, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [patientId, appointmentDate, appointmentTime, visitType, status, String(userId)]
  );
  return rows[0];
}

async function findById(id, { userId = null } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `SELECT * FROM appointments WHERE id = $1 AND user_id = $2`,
      [id, String(userId)]
    );
    return rows[0] || null;
  }
  const { rows } = await query(`SELECT * FROM appointments WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findAll({ userId, limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT * FROM appointments
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [String(userId), limit, offset]
  );
  return rows;
}

async function update(id, fields) {
  const allowed = [
    'patient_id',
    'appointment_date',
    'appointment_time',
    'visit_type',
    'status',
  ];
  const sets = [];
  const values = [id];
  const userId = fields.userId != null ? String(fields.userId) : null;

  for (const key of allowed) {
    const camel =
      key === 'patient_id'
        ? 'patientId'
        : key === 'appointment_date'
          ? 'appointmentDate'
          : key === 'appointment_time'
            ? 'appointmentTime'
            : key === 'visit_type'
              ? 'visitType'
              : key;
    if (fields[camel] !== undefined || fields[key] !== undefined) {
      values.push(fields[camel] !== undefined ? fields[camel] : fields[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }

  if (sets.length === 0) {
    return findById(id, { userId });
  }

  let where = 'WHERE id = $1';
  if (userId != null) {
    values.push(userId);
    where += ` AND user_id = $${values.length}`;
  }

  const { rows } = await query(
    `UPDATE appointments
     SET ${sets.join(', ')}
     ${where}
     RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function updateStatus(id, status, { userId = null } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `UPDATE appointments
       SET status = $2
       WHERE id = $1 AND user_id = $3
       RETURNING *`,
      [id, status, String(userId)]
    );
    return rows[0] || null;
  }
  const { rows } = await query(
    `UPDATE appointments
     SET status = $2
     WHERE id = $1
     RETURNING *`,
    [id, status]
  );
  return rows[0] || null;
}

async function remove(id, { userId = null } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `DELETE FROM appointments WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, String(userId)]
    );
    return rows[0] || null;
  }
  const { rows } = await query(`DELETE FROM appointments WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}

async function findByPatientId(patientId, { userId = null } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `SELECT *
       FROM appointments
       WHERE patient_id = $1 AND user_id = $2
       ORDER BY created_at DESC, id DESC`,
      [patientId, String(userId)]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT *
     FROM appointments
     WHERE patient_id = $1
     ORDER BY created_at DESC, id DESC`,
    [patientId]
  );
  return rows;
}

async function findByDateRange(startDate, endDate, { status = null, userId } = {}) {
  const uid = String(userId);
  if (status) {
    const { rows } = await query(
      `SELECT *
       FROM appointments
       WHERE user_id = $1
         AND appointment_date >= $2
         AND appointment_date <= $3
         AND status = $4
       ORDER BY appointment_date, appointment_time`,
      [uid, startDate, endDate, status]
    );
    return rows;
  }

  const { rows } = await query(
    `SELECT *
     FROM appointments
     WHERE user_id = $1
       AND appointment_date >= $2
       AND appointment_date <= $3
     ORDER BY appointment_date, appointment_time`,
    [uid, startDate, endDate]
  );
  return rows;
}

async function findByStatus(status, { userId, limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT *
     FROM appointments
     WHERE user_id = $1 AND status = $2
     ORDER BY appointment_date, appointment_time
     LIMIT $3 OFFSET $4`,
    [String(userId), status, limit, offset]
  );
  return rows;
}

/** Latest appointment still waiting on a reminder for a patient. */
async function findLatestPendingByPatient(patientId, { userId = null } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `SELECT *
       FROM appointments
       WHERE patient_id = $1
         AND user_id = $2
         AND status IN ('scheduled', 'needs_review', 'no_response')
       ORDER BY appointment_date DESC, appointment_time DESC
       LIMIT 1`,
      [patientId, String(userId)]
    );
    return rows[0] || null;
  }
  const { rows } = await query(
    `SELECT *
     FROM appointments
     WHERE patient_id = $1
       AND status IN ('scheduled', 'needs_review', 'no_response')
     ORDER BY appointment_date DESC, appointment_time DESC
     LIMIT 1`,
    [patientId]
  );
  return rows[0] || null;
}

/**
 * Scheduled appointments whose last outbound was sent more than `hours` ago
 * with no inbound reply afterward. Powers fallback cron + alert dashboard.
 */
async function findWithoutResponseOlderThan(hours, { userId = null } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `SELECT *
       FROM v_pending_no_response
       WHERE user_id = $1
         AND hours_since_outbound >= $2
       ORDER BY hours_since_outbound DESC`,
      [String(userId), hours]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT *
     FROM v_pending_no_response
     WHERE hours_since_outbound >= $1
     ORDER BY hours_since_outbound DESC`,
    [hours]
  );
  return rows;
}

async function getStatusSummary({
  userId,
  startDate = null,
  endDate = null,
  awaitingSend = false,
  awaitingReply = false,
} = {}) {
  const uid = String(userId);
  const clauses = ['user_id = $1'];
  const params = [uid];

  if (startDate && endDate) {
    params.push(startDate, endDate);
    clauses.push(`appointment_date >= $${params.length - 1}`);
    clauses.push(`appointment_date <= $${params.length}`);
  }
  if (awaitingSend) {
    clauses.push('awaiting_send = TRUE');
  }
  if (awaitingReply) {
    clauses.push('awaiting_reply = TRUE');
  }

  const order =
    startDate && endDate
      ? 'ORDER BY appointment_date, appointment_time'
      : 'ORDER BY created_at DESC, appointment_id DESC';

  const { rows } = await query(
    `SELECT *
     FROM v_appointment_status_summary
     WHERE ${clauses.join(' AND ')}
     ${order}`,
    params
  );
  return rows;
}

async function countActiveByDate(date, { userId } = {}) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n
     FROM appointments
     WHERE user_id = $1
       AND appointment_date = $2
       AND status <> 'cancelled'`,
    [String(userId), date]
  );
  return rows[0]?.n ?? 0;
}

/** Active (non-cancelled) start times for a calendar date — used by slot picker. */
async function listActiveTimesByDate(date, { userId } = {}) {
  const { rows } = await query(
    `SELECT to_char(appointment_time, 'HH24:MI') AS appointment_time
     FROM appointments
     WHERE user_id = $1
       AND appointment_date = $2
       AND status <> 'cancelled'
     ORDER BY appointment_time`,
    [String(userId), date]
  );
  return rows.map((r) => r.appointment_time);
}

/**
 * Scheduled appointments whose start is in (now, now + maxHoursAhead].
 * Used by auto-reminder cron — always scoped to one user.
 */
async function findScheduledWithinHours(maxHoursAhead, { userId } = {}) {
  const hours = Math.max(1, Number(maxHoursAhead) || 24);
  const { rows } = await query(
    `SELECT
       a.*,
       (a.appointment_date + a.appointment_time) AS appointment_at,
       EXTRACT(EPOCH FROM ((a.appointment_date + a.appointment_time) - NOW())) / 3600.0
         AS hours_until
     FROM appointments a
     WHERE a.user_id = $1
       AND a.status = 'scheduled'
       AND (a.appointment_date + a.appointment_time) > NOW()
       AND (a.appointment_date + a.appointment_time) <= NOW() + ($2::text || ' hours')::interval
     ORDER BY a.appointment_date, a.appointment_time`,
    [String(userId), String(hours)]
  );
  return rows;
}

module.exports = {
  create,
  findById,
  findAll,
  update,
  updateStatus,
  remove,
  findByPatientId,
  findByDateRange,
  findByStatus,
  findLatestPendingByPatient,
  findWithoutResponseOlderThan,
  getStatusSummary,
  countActiveByDate,
  listActiveTimesByDate,
  findScheduledWithinHours,
};
