/**
 * Per-user clinic settings (channels, reminder offsets, hours, exceptions).
 * Keyed by front SessionStore user id as text (e.g. "1", "2" from Bearer mock-{id}).
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
  pgm.createTable('clinic_settings', {
    user_id: { type: 'varchar(64)', primaryKey: true },
    default_channel: { type: 'varchar(32)', notNull: true, default: 'bale' },
    enabled_channels: { type: 'jsonb', notNull: true },
    reminder_send_count: { type: 'integer', notNull: true, default: 2 },
    reminder_offsets_hours: { type: 'jsonb', notNull: true },
    fallback_after_hours: { type: 'double precision', notNull: true, default: 4 },
    session_duration_minutes: { type: 'integer', notNull: true, default: 30 },
    weekly_hours: { type: 'jsonb', notNull: true },
    day_exceptions: { type: 'jsonb', notNull: true, default: pgm.func(`'[]'::jsonb`) },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('clinic_settings', 'clinic_settings_default_channel_check', {
    check: "default_channel IN ('sms', 'bale', 'whatsapp', 'telegram')",
  });
  pgm.addConstraint('clinic_settings', 'clinic_settings_session_duration_check', {
    check: 'session_duration_minutes BETWEEN 5 AND 240',
  });
  pgm.addConstraint('clinic_settings', 'clinic_settings_fallback_hours_check', {
    check: 'fallback_after_hours >= 1 AND fallback_after_hours <= 72',
  });
  pgm.addConstraint('clinic_settings', 'clinic_settings_reminder_count_check', {
    check: 'reminder_send_count BETWEEN 1 AND 5',
  });

  pgm.sql(`
    CREATE TRIGGER trg_clinic_settings_updated_at
      BEFORE UPDATE ON clinic_settings
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  `);
};

/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_clinic_settings_updated_at ON clinic_settings');
  pgm.dropTable('clinic_settings');
};
