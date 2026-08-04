/**
 * Multi-tenant isolation: user_id on operational tables + per-user message template.
 * Orphan rows backfill to user_id '1' (sample / Alon).
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
  const defaultUser = String(process.env.DEFAULT_SETTINGS_USER_ID || '1');

  // --- patients ---
  pgm.addColumn('patients', {
    user_id: { type: 'varchar(64)' },
  });
  pgm.sql(`UPDATE patients SET user_id = '${defaultUser}' WHERE user_id IS NULL`);
  pgm.alterColumn('patients', 'user_id', { notNull: true });
  pgm.createIndex('patients', 'user_id', { name: 'idx_patients_user_id' });
  pgm.createIndex('patients', ['user_id', 'id'], { name: 'idx_patients_user_id_id' });

  // --- patient_channel_identities (inherit owner; allow same phone across tenants) ---
  pgm.addColumn('patient_channel_identities', {
    user_id: { type: 'varchar(64)' },
  });
  pgm.sql(`
    UPDATE patient_channel_identities pci
    SET user_id = p.user_id
    FROM patients p
    WHERE p.id = pci.patient_id AND pci.user_id IS NULL
  `);
  pgm.sql(
    `UPDATE patient_channel_identities SET user_id = '${defaultUser}' WHERE user_id IS NULL`
  );
  pgm.alterColumn('patient_channel_identities', 'user_id', { notNull: true });
  pgm.dropConstraint(
    'patient_channel_identities',
    'patient_channel_identities_channel_external_id_key'
  );
  pgm.addConstraint(
    'patient_channel_identities',
    'patient_channel_identities_user_channel_external_id_key',
    { unique: ['user_id', 'channel', 'external_id'] }
  );
  pgm.createIndex('patient_channel_identities', 'user_id', {
    name: 'idx_patient_channel_identities_user_id',
  });

  // --- appointments ---
  pgm.addColumn('appointments', {
    user_id: { type: 'varchar(64)' },
  });
  pgm.sql(`
    UPDATE appointments a
    SET user_id = p.user_id
    FROM patients p
    WHERE p.id = a.patient_id AND a.user_id IS NULL
  `);
  pgm.sql(`UPDATE appointments SET user_id = '${defaultUser}' WHERE user_id IS NULL`);
  pgm.alterColumn('appointments', 'user_id', { notNull: true });
  pgm.createIndex('appointments', 'user_id', { name: 'idx_appointments_user_id' });
  pgm.createIndex('appointments', ['user_id', 'appointment_date', 'status'], {
    name: 'idx_appointments_user_date_status',
  });
  pgm.createIndex('appointments', ['user_id', 'patient_id'], {
    name: 'idx_appointments_user_patient',
  });

  // --- messages ---
  pgm.addColumn('messages', {
    user_id: { type: 'varchar(64)' },
  });
  pgm.sql(`
    UPDATE messages m
    SET user_id = a.user_id
    FROM appointments a
    WHERE a.id = m.appointment_id AND m.user_id IS NULL
  `);
  pgm.sql(`UPDATE messages SET user_id = '${defaultUser}' WHERE user_id IS NULL`);
  pgm.alterColumn('messages', 'user_id', { notNull: true });
  pgm.createIndex('messages', 'user_id', { name: 'idx_messages_user_id' });
  pgm.createIndex('messages', ['user_id', 'appointment_id'], {
    name: 'idx_messages_user_appointment',
  });

  // --- reminder_attempts ---
  pgm.addColumn('reminder_attempts', {
    user_id: { type: 'varchar(64)' },
  });
  pgm.sql(`
    UPDATE reminder_attempts ra
    SET user_id = a.user_id
    FROM appointments a
    WHERE a.id = ra.appointment_id AND ra.user_id IS NULL
  `);
  pgm.sql(`UPDATE reminder_attempts SET user_id = '${defaultUser}' WHERE user_id IS NULL`);
  pgm.alterColumn('reminder_attempts', 'user_id', { notNull: true });
  pgm.createIndex('reminder_attempts', 'user_id', { name: 'idx_reminder_attempts_user_id' });

  // --- activity_log ---
  pgm.addColumn('activity_log', {
    user_id: { type: 'varchar(64)' },
  });
  pgm.sql(`
    UPDATE activity_log al
    SET user_id = a.user_id
    FROM appointments a
    WHERE a.id = al.appointment_id AND al.user_id IS NULL
  `);
  pgm.sql(`UPDATE activity_log SET user_id = '${defaultUser}' WHERE user_id IS NULL`);
  pgm.alterColumn('activity_log', 'user_id', { notNull: true });
  pgm.createIndex('activity_log', 'user_id', { name: 'idx_activity_log_user_id' });

  // --- per-user message template header (editable part only) ---
  pgm.sql(`
    ALTER TABLE clinic_settings
      ADD COLUMN IF NOT EXISTS message_template_header text
      NOT NULL
      DEFAULT E'سلام وقت شما بخیر\\nوقت مراجعه {{visitType}} شما :\\n{{when}}\\n\\nلطفا حتما'
  `);

  // --- recreate views with user_id (must DROP — CREATE OR REPLACE cannot insert columns) ---
  pgm.sql('DROP VIEW IF EXISTS v_pending_no_response');
  pgm.sql('DROP VIEW IF EXISTS v_appointment_status_summary');

  pgm.sql(`
    CREATE VIEW v_appointment_status_summary AS
    SELECT
      a.id AS appointment_id,
      a.user_id,
      a.patient_id,
      p.name AS patient_name,
      a.appointment_date,
      a.appointment_time,
      a.visit_type,
      a.status AS appointment_status,
      latest_out.channel AS latest_outbound_channel,
      latest_out.delivery_status AS latest_outbound_delivery_status,
      latest_out.sent_at AS latest_outbound_sent_at,
      EXISTS (
        SELECT 1
        FROM messages m_in
        WHERE m_in.appointment_id = a.id
          AND m_in.direction = 'inbound'
      ) AS has_response,
      latest_in.content AS latest_inbound_content,
      latest_in.created_at AS latest_inbound_at,
      a.created_at,
      a.updated_at
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN LATERAL (
      SELECT m.channel, m.delivery_status, m.sent_at, m.created_at
      FROM messages m
      WHERE m.appointment_id = a.id
        AND m.direction = 'outbound'
      ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
      LIMIT 1
    ) latest_out ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.content, m.created_at
      FROM messages m
      WHERE m.appointment_id = a.id
        AND m.direction = 'inbound'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ) latest_in ON TRUE
  `);

  pgm.sql(`
    CREATE VIEW v_pending_no_response AS
    SELECT
      a.id AS appointment_id,
      a.user_id,
      a.patient_id,
      p.name AS patient_name,
      a.appointment_date,
      a.appointment_time,
      a.visit_type,
      a.status,
      last_out.id AS last_outbound_message_id,
      last_out.channel AS last_outbound_channel,
      last_out.delivery_status AS last_outbound_delivery_status,
      last_out.sent_at AS last_outbound_sent_at,
      EXTRACT(EPOCH FROM (NOW() - last_out.sent_at)) / 3600.0 AS hours_since_outbound
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN LATERAL (
      SELECT m.id, m.channel, m.delivery_status, m.sent_at
      FROM messages m
      WHERE m.appointment_id = a.id
        AND m.direction = 'outbound'
        AND m.sent_at IS NOT NULL
      ORDER BY m.sent_at DESC, m.id DESC
      LIMIT 1
    ) last_out ON TRUE
    WHERE a.status = 'scheduled'
      AND NOT EXISTS (
        SELECT 1
        FROM messages m_in
        WHERE m_in.appointment_id = a.id
          AND m_in.direction = 'inbound'
          AND m_in.created_at > last_out.sent_at
      )
  `);
};

/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS v_pending_no_response');
  pgm.sql('DROP VIEW IF EXISTS v_appointment_status_summary');

  pgm.sql(`
    CREATE VIEW v_appointment_status_summary AS
    SELECT
      a.id AS appointment_id,
      a.patient_id,
      p.name AS patient_name,
      a.appointment_date,
      a.appointment_time,
      a.visit_type,
      a.status AS appointment_status,
      latest_out.channel AS latest_outbound_channel,
      latest_out.delivery_status AS latest_outbound_delivery_status,
      latest_out.sent_at AS latest_outbound_sent_at,
      EXISTS (
        SELECT 1
        FROM messages m_in
        WHERE m_in.appointment_id = a.id
          AND m_in.direction = 'inbound'
      ) AS has_response,
      latest_in.content AS latest_inbound_content,
      latest_in.created_at AS latest_inbound_at,
      a.created_at,
      a.updated_at
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN LATERAL (
      SELECT m.channel, m.delivery_status, m.sent_at, m.created_at
      FROM messages m
      WHERE m.appointment_id = a.id
        AND m.direction = 'outbound'
      ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
      LIMIT 1
    ) latest_out ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.content, m.created_at
      FROM messages m
      WHERE m.appointment_id = a.id
        AND m.direction = 'inbound'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ) latest_in ON TRUE
  `);

  pgm.sql(`
    CREATE VIEW v_pending_no_response AS
    SELECT
      a.id AS appointment_id,
      a.patient_id,
      p.name AS patient_name,
      a.appointment_date,
      a.appointment_time,
      a.visit_type,
      a.status,
      last_out.id AS last_outbound_message_id,
      last_out.channel AS last_outbound_channel,
      last_out.delivery_status AS last_outbound_delivery_status,
      last_out.sent_at AS last_outbound_sent_at,
      EXTRACT(EPOCH FROM (NOW() - last_out.sent_at)) / 3600.0 AS hours_since_outbound
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN LATERAL (
      SELECT m.id, m.channel, m.delivery_status, m.sent_at
      FROM messages m
      WHERE m.appointment_id = a.id
        AND m.direction = 'outbound'
        AND m.sent_at IS NOT NULL
      ORDER BY m.sent_at DESC, m.id DESC
      LIMIT 1
    ) last_out ON TRUE
    WHERE a.status = 'scheduled'
      AND NOT EXISTS (
        SELECT 1
        FROM messages m_in
        WHERE m_in.appointment_id = a.id
          AND m_in.direction = 'inbound'
          AND m_in.created_at > last_out.sent_at
      )
  `);

  pgm.dropColumns('clinic_settings', ['message_template_header']);

  pgm.dropIndex('activity_log', 'user_id', { name: 'idx_activity_log_user_id' });
  pgm.dropColumns('activity_log', ['user_id']);

  pgm.dropIndex('reminder_attempts', 'user_id', { name: 'idx_reminder_attempts_user_id' });
  pgm.dropColumns('reminder_attempts', ['user_id']);

  pgm.dropIndex('messages', ['user_id', 'appointment_id'], {
    name: 'idx_messages_user_appointment',
  });
  pgm.dropIndex('messages', 'user_id', { name: 'idx_messages_user_id' });
  pgm.dropColumns('messages', ['user_id']);

  pgm.dropIndex('appointments', ['user_id', 'patient_id'], {
    name: 'idx_appointments_user_patient',
  });
  pgm.dropIndex('appointments', ['user_id', 'appointment_date', 'status'], {
    name: 'idx_appointments_user_date_status',
  });
  pgm.dropIndex('appointments', 'user_id', { name: 'idx_appointments_user_id' });
  pgm.dropColumns('appointments', ['user_id']);

  pgm.dropConstraint(
    'patient_channel_identities',
    'patient_channel_identities_user_channel_external_id_key'
  );
  pgm.addConstraint(
    'patient_channel_identities',
    'patient_channel_identities_channel_external_id_key',
    { unique: ['channel', 'external_id'] }
  );
  pgm.dropIndex('patient_channel_identities', 'user_id', {
    name: 'idx_patient_channel_identities_user_id',
  });
  pgm.dropColumns('patient_channel_identities', ['user_id']);

  pgm.dropIndex('patients', ['user_id', 'id'], { name: 'idx_patients_user_id_id' });
  pgm.dropIndex('patients', 'user_id', { name: 'idx_patients_user_id' });
  pgm.dropColumns('patients', ['user_id']);
};
