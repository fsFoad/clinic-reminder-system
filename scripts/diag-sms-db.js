'use strict';

require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const patients = await pool.query(
      `SELECT p.id, p.name, i.channel, i.external_id, i.is_preferred
       FROM patients p
       LEFT JOIN patient_channel_identities i ON i.patient_id = p.id
       WHERE p.name ILIKE $1
          OR i.external_id LIKE $2
          OR i.external_id LIKE $3
       ORDER BY p.id, i.channel`,
      ['%فواد%', '%9195607793%', '%09195607793%']
    );
    console.log('=== PATIENTS ===');
    console.log(JSON.stringify(patients.rows, null, 2));

    const msgs = await pool.query(
      `SELECT m.id, m.appointment_id, m.channel, m.direction, m.delivery_status,
              m.provider_message_id, m.provider_pack_id, m.sent_at, m.created_at,
              left(m.content, 80) AS content_preview
       FROM messages m
       WHERE m.channel = 'sms'
       ORDER BY m.id DESC
       LIMIT 25`
    );
    console.log('=== RECENT SMS MESSAGES ===');
    console.log(JSON.stringify(msgs.rows, null, 2));

    const attempts = await pool.query(
      `SELECT id, appointment_id, channel, attempt_number, created_at
       FROM reminder_attempts
       ORDER BY id DESC
       LIMIT 20`
    );
    console.log('=== RECENT ATTEMPTS ===');
    console.log(JSON.stringify(attempts.rows, null, 2));

    const activity = await pool.query(
      `SELECT id, appointment_id, event_type, details, created_at
       FROM activity_log
       WHERE event_type ILIKE '%remind%'
          OR details::text ILIKE '%smsir%'
          OR details::text ILIKE '%9195607793%'
          OR details::text ILIKE '%provider_message%'
       ORDER BY id DESC
       LIMIT 25`
    );
    console.log('=== ACTIVITY ===');
    console.log(JSON.stringify(activity.rows, null, 2));

    const docs = await pool.query(
      `SELECT id, provider_message_id, provider_pack_id, delivery_status, created_at
       FROM messages
       WHERE provider_pack_id = '2b99e63c-9bf8-4a21-9bfe-3f72dc1b46f1'
          OR provider_message_id IN ('86522023','86522024')
          OR provider_pack_id LIKE 'dry-pack-%'
       ORDER BY id DESC
       LIMIT 20`
    );
    console.log('=== FAKE/DOCS/DRY IDS IN DB ===');
    console.log(JSON.stringify(docs.rows, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
