-- Clinic Appointment Reminder System — full DDL
-- Timestamps are stored in UTC (TIMESTAMPTZ). Convert to Asia/Tehran in the app.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Helper: auto-update updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- patients (مراجعین)
-- appointments.patient_id → patients.id  (1 patient : N appointments)
-- patient_channel_identities.patient_id → patients.id  (1 patient : N channels)
-- ---------------------------------------------------------------------------
CREATE TABLE patients (
  id          BIGSERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_patients_updated_at
  BEFORE UPDATE ON patients
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- patient_channel_identities
-- ---------------------------------------------------------------------------
CREATE TABLE patient_channel_identities (
  id          BIGSERIAL PRIMARY KEY,
  patient_id  BIGINT NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  channel     VARCHAR(32) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  is_preferred BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT patient_channel_identities_channel_check
    CHECK (channel IN ('sms', 'bale', 'whatsapp', 'telegram')),
  CONSTRAINT patient_channel_identities_channel_external_id_key
    UNIQUE (channel, external_id)
);

CREATE INDEX idx_patient_channel_identities_patient_id
  ON patient_channel_identities (patient_id);

-- ---------------------------------------------------------------------------
-- appointments (نوبت‌ها) — always belongs to one patient
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
  id               BIGSERIAL PRIMARY KEY,
  patient_id       BIGINT NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  appointment_date DATE NOT NULL,
  appointment_time TIME NOT NULL,
  visit_type       VARCHAR(255),
  status           VARCHAR(32) NOT NULL DEFAULT 'scheduled',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT appointments_status_check
    CHECK (status IN (
      'scheduled',
      'confirmed',
      'rescheduled',
      'cancelled',
      'needs_review',
      'no_response'
    ))
);

CREATE INDEX idx_appointments_date_status
  ON appointments (appointment_date, status);

CREATE INDEX idx_appointments_patient_id
  ON appointments (patient_id);

CREATE TRIGGER trg_appointments_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id                  BIGSERIAL PRIMARY KEY,
  appointment_id      BIGINT NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  channel             VARCHAR(32) NOT NULL,
  direction           VARCHAR(16) NOT NULL,
  content             TEXT NOT NULL,
  provider_message_id VARCHAR(255),
  provider_pack_id    VARCHAR(255),
  -- Last known SMS.ir DeliveryState (1 delivered · 2/4/6/7 failed · 3/5 in progress).
  provider_delivery_state INT,
  delivery_status     VARCHAR(32) NOT NULL DEFAULT 'pending',
  note                VARCHAR(255),
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT messages_channel_check
    CHECK (channel IN ('sms', 'bale', 'whatsapp', 'telegram')),
  CONSTRAINT messages_direction_check
    CHECK (direction IN ('outbound', 'inbound')),
  CONSTRAINT messages_delivery_status_check
    CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'failed'))
);

CREATE INDEX idx_messages_appointment_delivery
  ON messages (appointment_id, delivery_status);

CREATE INDEX idx_messages_provider_message_id
  ON messages (provider_message_id);

-- ---------------------------------------------------------------------------
-- reminder_attempts
-- ---------------------------------------------------------------------------
CREATE TABLE reminder_attempts (
  id             BIGSERIAL PRIMARY KEY,
  appointment_id BIGINT NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  attempt_number INT NOT NULL DEFAULT 1,
  channel        VARCHAR(32) NOT NULL,
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reminder_attempts_channel_check
    CHECK (channel IN ('sms', 'bale', 'whatsapp', 'telegram'))
);

CREATE INDEX idx_reminder_attempts_appointment_id
  ON reminder_attempts (appointment_id);

-- ---------------------------------------------------------------------------
-- activity_log
-- ---------------------------------------------------------------------------
CREATE TABLE activity_log (
  id             BIGSERIAL PRIMARY KEY,
  appointment_id BIGINT REFERENCES appointments (id) ON DELETE CASCADE,
  event_type     VARCHAR(64) NOT NULL,
  details        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_log_appointment_created
  ON activity_log (appointment_id, created_at);

CREATE INDEX idx_activity_log_event_type
  ON activity_log (event_type);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- One row per appointment for the main dashboard table.
-- awaiting_send / awaiting_reply are computed pipeline states (not status enum values).
-- awaiting_reply requires delivered outbound — failed / still-checking DLR must not look like "waiting for reply".
-- Fresh installs: CREATE is fine. Live DBs: migration drops then recreates (OR REPLACE cannot add columns).
CREATE OR REPLACE VIEW v_appointment_status_summary AS
SELECT
  base.*,
  (base.appointment_status = 'scheduled' AND NOT base.reminder_sent) AS awaiting_send,
  (
    base.appointment_status = 'scheduled'
    AND base.reminder_sent
    AND NOT base.has_response
    AND base.latest_outbound_delivery_status = 'delivered'
  ) AS awaiting_reply
FROM (
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
    latest_out.provider_delivery_state AS latest_outbound_delivery_state,
    CASE
      WHEN latest_out.delivery_status = 'failed' THEN 'failed'
      WHEN latest_out.delivery_status = 'delivered' THEN 'delivered'
      WHEN latest_out.delivery_status IN ('sent', 'pending') THEN 'reviewing'
      ELSE NULL
    END AS latest_outbound_delivery_label,
    latest_out.sent_at AS latest_outbound_sent_at,
    latest_out.delivered_at AS latest_outbound_delivered_at,
    EXISTS (
      SELECT 1
      FROM messages m_in
      WHERE m_in.appointment_id = a.id
        AND m_in.direction = 'inbound'
    ) AS has_response,
    latest_in.content AS latest_inbound_content,
    latest_in.created_at AS latest_inbound_at,
    EXISTS (
      SELECT 1
      FROM messages m_sent
      WHERE m_sent.appointment_id = a.id
        AND m_sent.direction = 'outbound'
        AND m_sent.sent_at IS NOT NULL
    ) AS reminder_sent,
    a.created_at,
    a.updated_at
  FROM appointments a
  JOIN patients p ON p.id = a.patient_id
  LEFT JOIN LATERAL (
    SELECT m.channel, m.delivery_status, m.provider_delivery_state,
           m.sent_at, m.delivered_at, m.created_at
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
) base;

-- Scheduled appointments with an outbound reminder and no inbound reply yet.
-- Filter by hours_since_outbound in the app / cron (parameterized N hours).
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

-- ---------------------------------------------------------------------------
-- clinic_settings (per logged-in operator; user_id matches front SessionStore id)
-- ---------------------------------------------------------------------------
CREATE TABLE clinic_settings (
  user_id                   VARCHAR(64) PRIMARY KEY,
  default_channel           VARCHAR(32) NOT NULL DEFAULT 'bale'
    CHECK (default_channel IN ('sms', 'bale', 'whatsapp', 'telegram')),
  enabled_channels          JSONB NOT NULL,
  reminder_send_count       INTEGER NOT NULL DEFAULT 2
    CHECK (reminder_send_count BETWEEN 1 AND 5),
  reminder_offsets_hours    JSONB NOT NULL,
  fallback_after_hours      DOUBLE PRECISION NOT NULL DEFAULT 4
    CHECK (fallback_after_hours >= 1 AND fallback_after_hours <= 72),
  session_duration_minutes  INTEGER NOT NULL DEFAULT 30
    CHECK (session_duration_minutes BETWEEN 5 AND 240),
  weekly_hours              JSONB NOT NULL,
  day_exceptions            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_clinic_settings_updated_at
  BEFORE UPDATE ON clinic_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at(  );

-- ---------------------------------------------------------------------------
-- clinic_settings (per authenticated operator / front SessionStore user id)
-- ---------------------------------------------------------------------------
CREATE TABLE clinic_settings (
  user_id                   VARCHAR(64) PRIMARY KEY,
  default_channel           VARCHAR(32) NOT NULL DEFAULT 'bale'
    CHECK (default_channel IN ('sms', 'bale', 'whatsapp', 'telegram')),
  enabled_channels          JSONB NOT NULL,
  reminder_send_count       INTEGER NOT NULL DEFAULT 2
    CHECK (reminder_send_count BETWEEN 1 AND 5),
  reminder_offsets_hours    JSONB NOT NULL,
  fallback_after_hours      DOUBLE PRECISION NOT NULL DEFAULT 4
    CHECK (fallback_after_hours >= 1 AND fallback_after_hours <= 72),
  session_duration_minutes  INTEGER NOT NULL DEFAULT 30
    CHECK (session_duration_minutes BETWEEN 5 AND 240),
  weekly_hours              JSONB NOT NULL,
  day_exceptions            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_clinic_settings_updated_at
  BEFORE UPDATE ON clinic_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

COMMIT;
