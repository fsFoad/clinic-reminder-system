/**
 * Store last SMS.ir DeliveryState on messages, and tighten awaiting_reply so it
 * only applies when the latest outbound was actually delivered (not failed /
 * still under review with states 3/5 or DLR not yet final).
 *
 * Also expose latest_outbound_delivery_state + latest_outbound_delivery_label
 * on v_appointment_status_summary for the clinic UI.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
  pgm.addColumn('messages', {
    provider_delivery_state: { type: 'integer' },
  });

  pgm.sql('DROP VIEW IF EXISTS v_appointment_status_summary');

  pgm.sql(`
    CREATE VIEW v_appointment_status_summary AS
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
        SELECT m.channel, m.delivery_status, m.provider_delivery_state, m.sent_at, m.created_at
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
    ) base
  `);
};

/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS v_appointment_status_summary');

  pgm.sql(`
    CREATE VIEW v_appointment_status_summary AS
    SELECT
      base.*,
      (base.appointment_status = 'scheduled' AND NOT base.reminder_sent) AS awaiting_send,
      (base.appointment_status = 'scheduled' AND base.reminder_sent AND NOT base.has_response)
        AS awaiting_reply
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
        latest_out.sent_at AS latest_outbound_sent_at,
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
    ) base
  `);

  pgm.dropColumn('messages', 'provider_delivery_state');
};
