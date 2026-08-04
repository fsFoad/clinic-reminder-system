'use strict';

const fs = require('fs');
const path = require('path');
const clinicSettingsModel = require('../../db/models/clinicSettings');
const clinicSettings = require('./clinicSettings');

/**
 * Keywords the response parser treats as intents — never user-editable.
 */
const LOCKED_KEYWORDS = Object.freeze({
  confirm: 'تایید شود',
  reschedule: 'جابجا شود',
  cancel: 'کنسل شود',
});

const LOCKED_FOOTER = [
  '',
  '*درصورت تایید بفرمایید',
  ` « ${LOCKED_KEYWORDS.confirm}»`,
  '',
  `*درصورت درخواست جابجایی بفرمایید « ${LOCKED_KEYWORDS.reschedule}»`,
  '',
  `درصورت درخواست کنسلی بفرمایید « ${LOCKED_KEYWORDS.cancel}»`,
].join('\n');

/** Extra short-reply hints for SMS channel only (keeps Bale locked keywords intact). */
const SMS_REPLY_FOOTER = [
  '',
  'پاسخ سریع پیامکی:',
  '۲ = تایید',
  '۱ = لغو',
].join('\n');

const DEFAULT_HEADER = [
  'سلام وقت شما بخیر',
  'وقت مراجعه {{visitType}} شما :',
  '{{when}}',
  '',
  'لطفا حتما',
].join('\n');

/** Legacy global file — imported once into DEFAULT_SETTINGS_USER_ID then ignored. */
const LEGACY_STORE_PATH = path.join(__dirname, '../../data/message-template.json');

const KEYWORD_RE =
  /تایید\s*شود|تاييد\s*شود|جابجا\s*شود|جا\s*به\s*جا\s*شود|کنسل\s*شود|لغو\s*شود/i;

let legacyTemplateMigratePromise = null;

function formatWhenLabel(appointmentDate, appointmentTime, timeZone = 'Asia/Tehran') {
  const dateStr =
    typeof appointmentDate === 'string'
      ? appointmentDate.slice(0, 10)
      : appointmentDate.toISOString().slice(0, 10);

  let timeStr =
    typeof appointmentTime === 'string'
      ? appointmentTime.slice(0, 5)
      : String(appointmentTime).slice(0, 5);

  if (/^\d{2}:\d{2}:\d{2}/.test(timeStr)) {
    timeStr = timeStr.slice(0, 5);
  }

  const iso = `${dateStr}T${timeStr}:00`;
  const dt = new Date(iso);

  if (Number.isNaN(dt.getTime())) {
    return `${dateStr} ساعت${timeStr}`;
  }

  const weekday = new Intl.DateTimeFormat('fa-IR', {
    weekday: 'long',
    timeZone,
  }).format(dt);

  const dayMonth = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(dt);

  const [hh, mm] = timeStr.split(':');
  const hourLabel = `${Number(hh)}:${mm}`;

  return `${weekday} ${dayMonth} ساعت${hourLabel}`;
}

function assertHeaderSafe(header) {
  if (header == null || !String(header).trim()) {
    const err = new Error('header is required');
    err.status = 400;
    throw err;
  }
  if (KEYWORD_RE.test(String(header))) {
    const err = new Error(
      'editable header must not include reply keywords (تایید شود / جابجا شود / کنسل شود)'
    );
    err.status = 400;
    throw err;
  }
}

function readLegacyHeader() {
  try {
    if (fs.existsSync(LEGACY_STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LEGACY_STORE_PATH, 'utf8'));
      if (raw && typeof raw.header === 'string' && raw.header.trim()) {
        return raw.header;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * One-time: copy legacy data/message-template.json into the default user's
 * clinic_settings.message_template_header when still at DEFAULT_HEADER.
 */
async function migrateLegacyTemplateOnce() {
  if (!legacyTemplateMigratePromise) {
    legacyTemplateMigratePromise = (async () => {
      const targetUser = String(process.env.DEFAULT_SETTINGS_USER_ID || '1');
      const legacy = readLegacyHeader();
      if (!legacy) return { migrated: false, reason: 'no_legacy_json' };

      // Ensure settings row exists
      await clinicSettings.getSettings(targetUser);
      const row = await clinicSettingsModel.findByUserId(targetUser);
      if (!row) return { migrated: false, reason: 'no_settings_row' };

      const current = row.messageTemplateHeader || DEFAULT_HEADER;
      if (current !== DEFAULT_HEADER) {
        return { migrated: false, reason: 'already_customized', userId: targetUser };
      }

      await clinicSettingsModel.updateMessageTemplateHeader(targetUser, legacy);
      console.log(
        `[message-template] migrated legacy JSON → user_id=${targetUser} (${LEGACY_STORE_PATH})`
      );
      return { migrated: true, userId: targetUser };
    })().catch((err) => {
      legacyTemplateMigratePromise = null;
      console.error('[message-template] legacy migrate failed:', err.message || err);
      return { migrated: false, reason: 'error', error: err.message || String(err) };
    });
  }
  return legacyTemplateMigratePromise;
}

function toDto(header) {
  return {
    header: header || DEFAULT_HEADER,
    lockedFooter: LOCKED_FOOTER,
    smsReplyFooter: SMS_REPLY_FOOTER,
    lockedKeywords: { ...LOCKED_KEYWORDS },
    placeholders: ['{{visitType}}', '{{when}}'],
  };
}

/**
 * Load editable header for a user (seeds clinic_settings defaults on first touch).
 * @param {string|number} userId
 */
async function getTemplate(userId) {
  await migrateLegacyTemplateOnce();
  const settings = await clinicSettings.getSettings(userId);
  const header =
    settings.messageTemplateHeader && String(settings.messageTemplateHeader).trim()
      ? String(settings.messageTemplateHeader)
      : DEFAULT_HEADER;
  return toDto(header);
}

/**
 * Persist editable header for a user.
 * @param {string|number} userId
 * @param {{ header: string }} body
 */
async function updateTemplate(userId, { header }) {
  assertHeaderSafe(header);
  const cleaned = String(header).replace(/\s+$/g, '');
  // Ensure row exists
  await clinicSettings.getSettings(userId);
  await clinicSettingsModel.updateMessageTemplateHeader(userId, cleaned);
  return getTemplate(userId);
}

/**
 * Build outbound reminder body using THAT user's template header.
 * @param {string|number} userId
 * @param {{ visitType?: string, appointmentDate: *, appointmentTime: *, channel?: string }} fields
 */
async function buildReminderMessage(userId, { visitType, appointmentDate, appointmentTime, channel }) {
  const tpl = await getTemplate(userId);
  const typeLabel = visitType || 'مراجعه';
  const when = formatWhenLabel(appointmentDate, appointmentTime);

  const filled = tpl.header
    .replaceAll('{{visitType}}', typeLabel)
    .replaceAll('{{when}}', when);

  let body = `${filled}\n${LOCKED_FOOTER}`;
  if (channel === 'sms') {
    body += `\n${SMS_REPLY_FOOTER}`;
  }
  return body;
}

module.exports = {
  LOCKED_KEYWORDS,
  LOCKED_FOOTER,
  SMS_REPLY_FOOTER,
  DEFAULT_HEADER,
  formatWhenLabel,
  buildReminderMessage,
  getTemplate,
  updateTemplate,
  assertHeaderSafe,
  migrateLegacyTemplateOnce,
};
