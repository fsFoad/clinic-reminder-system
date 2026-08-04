/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.createTable('patients', {
    id: { type: 'bigserial', primaryKey: true },
    name: { type: 'varchar(255)', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.sql(`
    CREATE TRIGGER trg_patients_updated_at
      BEFORE UPDATE ON patients
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  `);

  pgm.createTable('patient_channel_identities', {
    id: { type: 'bigserial', primaryKey: true },
    patient_id: {
      type: 'bigint',
      notNull: true,
      references: 'patients',
      onDelete: 'CASCADE',
    },
    channel: { type: 'varchar(32)', notNull: true },
    external_id: { type: 'varchar(255)', notNull: true },
    is_preferred: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('patient_channel_identities', 'patient_channel_identities_channel_check', {
    check: "channel IN ('sms', 'bale', 'whatsapp', 'telegram')",
  });
  pgm.addConstraint(
    'patient_channel_identities',
    'patient_channel_identities_channel_external_id_key',
    { unique: ['channel', 'external_id'] }
  );
  pgm.createIndex('patient_channel_identities', 'patient_id', {
    name: 'idx_patient_channel_identities_patient_id',
  });

  pgm.createTable('appointments', {
    id: { type: 'bigserial', primaryKey: true },
    patient_id: {
      type: 'bigint',
      notNull: true,
      references: 'patients',
      onDelete: 'RESTRICT',
    },
    appointment_date: { type: 'date', notNull: true },
    appointment_time: { type: 'time', notNull: true },
    visit_type: { type: 'varchar(255)' },
    status: { type: 'varchar(32)', notNull: true, default: 'scheduled' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('appointments', 'appointments_status_check', {
    check:
      "status IN ('scheduled', 'confirmed', 'rescheduled', 'cancelled', 'needs_review', 'no_response')",
  });
  pgm.createIndex('appointments', ['appointment_date', 'status'], {
    name: 'idx_appointments_date_status',
  });
  pgm.createIndex('appointments', 'patient_id', {
    name: 'idx_appointments_patient_id',
  });
  pgm.sql(`
    CREATE TRIGGER trg_appointments_updated_at
      BEFORE UPDATE ON appointments
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  `);

  pgm.createTable('messages', {
    id: { type: 'bigserial', primaryKey: true },
    appointment_id: {
      type: 'bigint',
      notNull: true,
      references: 'appointments',
      onDelete: 'CASCADE',
    },
    channel: { type: 'varchar(32)', notNull: true },
    direction: { type: 'varchar(16)', notNull: true },
    content: { type: 'text', notNull: true },
    provider_message_id: { type: 'varchar(255)' },
    delivery_status: { type: 'varchar(32)', notNull: true, default: 'pending' },
    note: { type: 'varchar(255)' },
    sent_at: { type: 'timestamptz' },
    delivered_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('messages', 'messages_channel_check', {
    check: "channel IN ('sms', 'bale', 'whatsapp', 'telegram')",
  });
  pgm.addConstraint('messages', 'messages_direction_check', {
    check: "direction IN ('outbound', 'inbound')",
  });
  pgm.addConstraint('messages', 'messages_delivery_status_check', {
    check: "delivery_status IN ('pending', 'sent', 'delivered', 'failed')",
  });
  pgm.createIndex('messages', ['appointment_id', 'delivery_status'], {
    name: 'idx_messages_appointment_delivery',
  });
  pgm.createIndex('messages', 'provider_message_id', {
    name: 'idx_messages_provider_message_id',
  });

  pgm.createTable('reminder_attempts', {
    id: { type: 'bigserial', primaryKey: true },
    appointment_id: {
      type: 'bigint',
      notNull: true,
      references: 'appointments',
      onDelete: 'CASCADE',
    },
    attempt_number: { type: 'integer', notNull: true, default: 1 },
    channel: { type: 'varchar(32)', notNull: true },
    attempted_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('reminder_attempts', 'reminder_attempts_channel_check', {
    check: "channel IN ('sms', 'bale', 'whatsapp', 'telegram')",
  });
  pgm.createIndex('reminder_attempts', 'appointment_id', {
    name: 'idx_reminder_attempts_appointment_id',
  });

  pgm.createTable('activity_log', {
    id: { type: 'bigserial', primaryKey: true },
    appointment_id: {
      type: 'bigint',
      references: 'appointments',
      onDelete: 'CASCADE',
    },
    event_type: { type: 'varchar(64)', notNull: true },
    details: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('activity_log', ['appointment_id', 'created_at'], {
    name: 'idx_activity_log_appointment_created',
  });
  pgm.createIndex('activity_log', 'event_type', {
    name: 'idx_activity_log_event_type',
  });

  pgm.sql(`
    CREATE OR REPLACE VIEW v_appointment_status_summary AS
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
    ) latest_in ON TRUE;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW v_pending_no_response AS
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
      );
  `);
};

/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS v_pending_no_response');
  pgm.sql('DROP VIEW IF EXISTS v_appointment_status_summary');
  pgm.dropTable('activity_log');
  pgm.dropTable('reminder_attempts');
  pgm.dropTable('messages');
  pgm.dropTable('appointments');
  pgm.dropTable('patient_channel_identities');
  pgm.dropTable('patients');
  pgm.sql('DROP FUNCTION IF EXISTS set_updated_at()');
};
