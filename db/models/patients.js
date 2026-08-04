'use strict';

const { query } = require('../pool');

async function create({ name, notes = null, userId }, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `INSERT INTO patients (name, notes, user_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [name, notes, String(userId)]
  );
  return rows[0];
}

async function findById(id, { userId = null } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `SELECT * FROM patients WHERE id = $1 AND user_id = $2`,
      [id, String(userId)]
    );
    return rows[0] || null;
  }
  const { rows } = await query(`SELECT * FROM patients WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findAll({ userId, limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT * FROM patients
     WHERE user_id = $1
     ORDER BY id
     LIMIT $2 OFFSET $3`,
    [String(userId), limit, offset]
  );
  return rows;
}

async function update(id, { name, notes, userId }, client = null) {
  const q = client ? client.query.bind(client) : query;
  if (userId != null) {
    const { rows } = await q(
      `UPDATE patients
       SET
         name = COALESCE($3, name),
         notes = $4
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, String(userId), name ?? null, notes !== undefined ? notes : null]
    );
    return rows[0] || null;
  }
  const { rows } = await q(
    `UPDATE patients
     SET
       name = COALESCE($2, name),
       notes = $3
     WHERE id = $1
     RETURNING *`,
    [id, name ?? null, notes !== undefined ? notes : null]
  );
  return rows[0] || null;
}

async function remove(id, { userId = null } = {}) {
  if (userId != null) {
    const { rows } = await query(
      `DELETE FROM patients WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, String(userId)]
    );
    return rows[0] || null;
  }
  const { rows } = await query(`DELETE FROM patients WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}

/** Patient plus channel identities, preferred first. Scoped by userId when provided. */
async function findWithChannels(id, { userId = null } = {}) {
  const patient = await findById(id, { userId });
  if (!patient) return null;

  const { rows: channels } = await query(
    `SELECT *
     FROM patient_channel_identities
     WHERE patient_id = $1
     ORDER BY is_preferred DESC, id`,
    [id]
  );

  return { ...patient, channels };
}

/** Prefer preferred channel; fall back to any identity for that channel. */
async function findPreferredChannel(patientId, channel = null) {
  if (channel) {
    const { rows } = await query(
      `SELECT *
       FROM patient_channel_identities
       WHERE patient_id = $1 AND channel = $2
       ORDER BY is_preferred DESC, id
       LIMIT 1`,
      [patientId, channel]
    );
    return rows[0] || null;
  }

  const { rows } = await query(
    `SELECT *
     FROM patient_channel_identities
     WHERE patient_id = $1
     ORDER BY is_preferred DESC, id
     LIMIT 1`,
    [patientId]
  );
  return rows[0] || null;
}

async function searchByName(nameFragment, { userId, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT *
     FROM patients
     WHERE user_id = $1
       AND name ILIKE $2
     ORDER BY name
     LIMIT $3`,
    [String(userId), `%${nameFragment}%`, limit]
  );
  return rows;
}

/**
 * Patients with channels + appointment count for the directory list.
 * Relationship: patients 1—* patient_channel_identities, patients 1—* appointments.
 */
async function listDirectory({ userId, q = null, limit = 200, offset = 0 } = {}) {
  const params = [String(userId)];
  let where = 'WHERE p.user_id = $1';
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    where += ` AND p.name ILIKE $${params.length}`;
  }
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const { rows } = await query(
    `SELECT
       p.id,
       p.user_id,
       p.name,
       p.notes,
       p.created_at,
       p.updated_at,
       (
         SELECT COUNT(*)::int
         FROM appointments a
         WHERE a.patient_id = p.id
           AND a.user_id = p.user_id
       ) AS appointment_count,
       COALESCE(
         (
           SELECT json_agg(
             json_build_object(
               'id', pci.id,
               'channel', pci.channel,
               'external_id', pci.external_id,
               'is_preferred', pci.is_preferred
             )
             ORDER BY pci.is_preferred DESC, pci.id
           )
           FROM patient_channel_identities pci
           WHERE pci.patient_id = p.id
         ),
         '[]'::json
       ) AS channels
     FROM patients p
     ${where}
     ORDER BY p.id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );
  return rows;
}

module.exports = {
  create,
  findById,
  findAll,
  update,
  remove,
  findWithChannels,
  findPreferredChannel,
  searchByName,
  listDirectory,
};
