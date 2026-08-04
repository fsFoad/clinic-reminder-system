'use strict';

const { query } = require('../pool');

function rowToRaw(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    defaultChannel: row.default_channel,
    enabledChannels: row.enabled_channels,
    reminderSendCount: row.reminder_send_count,
    reminderOffsetsHours: row.reminder_offsets_hours,
    fallbackAfterHours: row.fallback_after_hours,
    sessionDurationMinutes: row.session_duration_minutes,
    weeklyHours: row.weekly_hours,
    dayExceptions: row.day_exceptions,
    messageTemplateHeader: row.message_template_header,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findByUserId(userId) {
  const { rows } = await query(`SELECT * FROM clinic_settings WHERE user_id = $1`, [
    String(userId),
  ]);
  return rowToRaw(rows[0]) || null;
}

async function listUserIds() {
  const { rows } = await query(`SELECT user_id FROM clinic_settings ORDER BY user_id`);
  return rows.map((r) => String(r.user_id));
}

/**
 * Insert or replace core settings for a user.
 * @param {string} userId
 * @param {object} data camelCase fields matching the service persist shape
 */
async function upsert(userId, data) {
  const { rows } = await query(
    `INSERT INTO clinic_settings (
       user_id,
       default_channel,
       enabled_channels,
       reminder_send_count,
       reminder_offsets_hours,
       fallback_after_hours,
       session_duration_minutes,
       weekly_hours,
       day_exceptions,
       message_template_header
     ) VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8::jsonb,$9::jsonb,$10)
     ON CONFLICT (user_id) DO UPDATE SET
       default_channel = EXCLUDED.default_channel,
       enabled_channels = EXCLUDED.enabled_channels,
       reminder_send_count = EXCLUDED.reminder_send_count,
       reminder_offsets_hours = EXCLUDED.reminder_offsets_hours,
       fallback_after_hours = EXCLUDED.fallback_after_hours,
       session_duration_minutes = EXCLUDED.session_duration_minutes,
       weekly_hours = EXCLUDED.weekly_hours,
       day_exceptions = EXCLUDED.day_exceptions,
       message_template_header = COALESCE(EXCLUDED.message_template_header, clinic_settings.message_template_header)
     RETURNING *`,
    [
      String(userId),
      data.defaultChannel,
      JSON.stringify(data.enabledChannels),
      data.reminderSendCount,
      JSON.stringify(data.reminderOffsetsHours),
      data.fallbackAfterHours,
      data.sessionDurationMinutes,
      JSON.stringify(data.weeklyHours),
      JSON.stringify(data.dayExceptions || []),
      data.messageTemplateHeader != null
        ? String(data.messageTemplateHeader)
        : [
            'سلام وقت شما بخیر',
            'وقت مراجعه {{visitType}} شما :',
            '{{when}}',
            '',
            'لطفا حتما',
          ].join('\n'),
    ]
  );
  return rowToRaw(rows[0]);
}

/** Update only the editable message template header for a user. */
async function updateMessageTemplateHeader(userId, header) {
  const { rows } = await query(
    `UPDATE clinic_settings
     SET message_template_header = $2
     WHERE user_id = $1
     RETURNING *`,
    [String(userId), String(header)]
  );
  return rowToRaw(rows[0]) || null;
}

module.exports = {
  findByUserId,
  listUserIds,
  upsert,
  updateMessageTemplateHeader,
};
