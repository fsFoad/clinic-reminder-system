'use strict';

const { APPOINTMENT_STATUS } = require('../constants');

/**
 * Normalize Persian/Arabic digits and whitespace for keyword matching.
 */
function normalizeText(raw) {
  if (raw == null) return '';
  return String(raw)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u200c\u200f\u200e]/g, ' ')
    .replace(/[«»"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clinic locked phrases (تایید شود / جابجا شود / کنسل شود) stay first-class.
 * SMS short replies (1/2 and casual Persian/English) are merged carefully —
 * prefer whole-message matches for short tokens to limit false positives.
 */
const INTENT_PATTERNS = [
  {
    intent: 'confirm',
    status: APPOINTMENT_STATUS.CONFIRMED,
    patterns: [
      /تایید\s*شود/,
      /تاييد\s*شود/,
      /^(تایید|تاييد)$/,
      /^2$/,
      /^confirm$/i,
      /^(میام|ميام)$/,
      /^(اوکی|اوكي)$/,
      /^ok$/i,
      /^باشه$/,
    ],
  },
  {
    intent: 'reschedule',
    status: APPOINTMENT_STATUS.RESCHEDULED,
    patterns: [/جابجا\s*شود/, /جا\s*به\s*جا\s*شود/, /^جابجایی$/, /^جابجا$/],
  },
  {
    intent: 'cancel',
    status: APPOINTMENT_STATUS.CANCELLED,
    patterns: [
      /کنسل\s*شود/,
      /لغو\s*شود/,
      /^(کنسل|لغو)$/,
      /^1$/,
      /^cancel$/i,
      /^(انصراف|نمیام|نميام)$/,
    ],
  },
];

/**
 * Parse patient reply into a known intent.
 * @returns {{ intent: 'confirm'|'reschedule'|'cancel'|'unknown', status: string|null, normalized: string }}
 */
function parsePatientResponse(rawContent) {
  const normalized = normalizeText(rawContent);

  for (const { intent, status, patterns } of INTENT_PATTERNS) {
    if (patterns.some((re) => re.test(normalized))) {
      return { intent, status, normalized };
    }
  }

  return {
    intent: 'unknown',
    status: APPOINTMENT_STATUS.NEEDS_REVIEW,
    normalized,
  };
}

module.exports = {
  normalizeText,
  parsePatientResponse,
};
