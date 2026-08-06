require('dotenv').config();
const { query } = require('../db/pool');

(async () => {
  const a = await query(
    'SELECT id, status, patient_id FROM appointments WHERE id IN (13, 14)'
  );
  const m = await query(
    `SELECT id, appointment_id, direction, content, provider_message_id, created_at
     FROM messages
     WHERE id IN (483, 484)
        OR (direction = 'inbound' AND created_at > NOW() - interval '6 hours')
     ORDER BY id DESC
     LIMIT 20`
  );
  console.log(JSON.stringify({ appointments: a.rows, messages: m.rows }, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
