'use strict';

const { query } = require('../pool');
const { matchVariants, toLocal09 } = require('../../src/utils/iranMobile');

/** Per-channel id ranges so SMS / Bale / Telegram never share the same id space. */
const CHANNEL_ID_BASE = Object.freeze({
  sms: 100000,
  bale: 200000,
  telegram: 300000,
  whatsapp: 400000,
});
const CHANNEL_ID_SPAN = 100000;

async function allocateId(channel, client = null) {
  const base = CHANNEL_ID_BASE[channel];
  if (!base) {
    const err = new Error(`unsupported channel for id allocation: ${channel}`);
    err.status = 400;
    throw err;
  }
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `SELECT COALESCE(MAX(id), $1::bigint - 1) + 1 AS next_id
     FROM patient_channel_identities
     WHERE id >= $1::bigint AND id < $2::bigint`,
    [base, base + CHANNEL_ID_SPAN]
  );
  return Number(rows[0].next_id);
}

async function create(
  { patientId, channel, externalId, isPreferred = false, id = null, userId },
  client = null
) {
  const q = client ? client.query.bind(client) : query;
  const rowId = id != null ? Number(id) : await allocateId(channel, client);
  let storedExternalId = String(externalId).trim();
  if (channel === 'sms') {
    storedExternalId = toLocal09(storedExternalId) || storedExternalId;
  }
  const { rows } = await q(
    `INSERT INTO patient_channel_identities
       (id, patient_id, channel, external_id, is_preferred, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [rowId, patientId, channel, storedExternalId, isPreferred, String(userId)]
  );
  return rows[0];
}

async function findById(id) {
  const { rows } = await query(
    `SELECT * FROM patient_channel_identities WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function findByPatientId(patientId, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `SELECT *
     FROM patient_channel_identities
     WHERE patient_id = $1
     ORDER BY is_preferred DESC, id`,
    [patientId]
  );
  return rows;
}

async function findByChannelExternalId(channel, externalId, { userId = null } = {}) {
  const variants =
    channel === 'sms' ? matchVariants(externalId) : [String(externalId == null ? '' : externalId).trim()];
  const ids = variants.filter(Boolean);
  if (!ids.length) return null;

  if (userId != null) {
    const { rows } = await query(
      `SELECT *
       FROM patient_channel_identities
       WHERE user_id = $1 AND channel = $2 AND external_id = ANY($3::text[])
       ORDER BY id
       LIMIT 1`,
      [String(userId), channel, ids]
    );
    return rows[0] || null;
  }
  // Prefer oldest identity; tenant comes from the matched row's user_id.
  const { rows } = await query(
    `SELECT *
     FROM patient_channel_identities
     WHERE channel = $1 AND external_id = ANY($2::text[])
     ORDER BY id
     LIMIT 1`,
    [channel, ids]
  );
  return rows[0] || null;
}

async function update(id, { externalId, isPreferred, channel }, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `UPDATE patient_channel_identities
     SET
       external_id = COALESCE($2, external_id),
       is_preferred = COALESCE($3, is_preferred),
       channel = COALESCE($4, channel)
     WHERE id = $1
     RETURNING *`,
    [id, externalId ?? null, isPreferred ?? null, channel ?? null]
  );
  return rows[0] || null;
}

async function remove(id, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `DELETE FROM patient_channel_identities WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

/** Mark one identity preferred; clear preference on siblings for that patient. */
async function setPreferred(id, client = null) {
  const q = client ? client.query.bind(client) : query;
  const existing = await (async () => {
    const { rows } = await q(
      `SELECT * FROM patient_channel_identities WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  })();
  if (!existing) return null;

  await q(
    `UPDATE patient_channel_identities
     SET is_preferred = FALSE
     WHERE patient_id = $1`,
    [existing.patient_id]
  );

  const { rows } = await q(
    `UPDATE patient_channel_identities
     SET is_preferred = TRUE
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return rows[0];
}

module.exports = {
  CHANNEL_ID_BASE,
  CHANNEL_ID_SPAN,
  allocateId,
  create,
  findById,
  findByPatientId,
  findByChannelExternalId,
  update,
  remove,
  setPreferred,
};
