'use strict';

/**
 * One-shot: reassign patient_channel_identities.id into channel ranges.
 * sms 100000+, bale 200000+, telegram 300000+, whatsapp 400000+.
 *
 * Usage: node scripts/reassign-channel-ids.js
 */
require('dotenv').config();
const { pool } = require('../db/pool');

const BASE = {
  sms: 100000,
  bale: 200000,
  telegram: 300000,
  whatsapp: 400000,
};

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, channel FROM patient_channel_identities ORDER BY channel, id`
    );

    const counters = { ...BASE };
    const map = new Map(); // oldId -> newId

    for (const row of rows) {
      const base = BASE[row.channel];
      if (!base) continue;
      const newId = counters[row.channel]++;
      if (Number(row.id) === newId) continue;
      map.set(Number(row.id), newId);
    }

    // Move to temporary negative ids to avoid unique conflicts
    for (const [oldId] of map) {
      await client.query(`UPDATE patient_channel_identities SET id = $1 WHERE id = $2`, [
        -oldId,
        oldId,
      ]);
    }
    for (const [oldId, newId] of map) {
      await client.query(`UPDATE patient_channel_identities SET id = $1 WHERE id = $2`, [
        newId,
        -oldId,
      ]);
    }

    const maxId = Math.max(0, ...[...map.values()], ...rows.map((r) => Number(r.id)));
    await client.query(`SELECT setval('patient_channel_identities_id_seq', $1, true)`, [
      Math.max(maxId, 400000),
    ]);

    await client.query('COMMIT');
    console.log(`Reassigned ${map.size} channel identity ids.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
