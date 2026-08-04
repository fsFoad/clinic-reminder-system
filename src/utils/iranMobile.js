'use strict';

/**
 * Iranian mobile normalization for SMS.ir + identity matching.
 * Canonical local form in DB: 09xxxxxxxxx
 * SMS.ir mobiles array: 9xxxxxxxxx (no leading 0) — C#/docs examples use this.
 */

function mapPersianDigits(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function digitsOnly(raw) {
  return mapPersianDigits(raw).replace(/\D/g, '');
}

/**
 * @returns {string|null} 10-digit national mobile starting with 9
 */
function toNational10(raw) {
  let d = digitsOnly(raw);
  if (!d) return null;
  if (d.startsWith('0098')) d = d.slice(4);
  else if (d.startsWith('098')) d = d.slice(3);
  else if (d.startsWith('98') && d.length >= 12) d = d.slice(2);
  if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  if (d.length === 10 && d.startsWith('9')) return d;
  return null;
}

/** Form for SMS.ir `mobiles` array (no leading 0). */
function toApiMobile(raw) {
  return toNational10(raw);
}

/** Preferred storage form: 09xxxxxxxxx */
function toLocal09(raw) {
  const n = toNational10(raw);
  return n ? `0${n}` : null;
}

/**
 * All common string forms for SQL matching against patient_channel_identities.external_id.
 * Falls back to trimmed original when not a recognizable Iranian mobile.
 */
function matchVariants(raw) {
  const trimmed = String(raw == null ? '' : raw).trim();
  const n = toNational10(raw);
  if (!n) return trimmed ? [trimmed] : [];
  return [...new Set([n, `0${n}`, `+98${n}`, `98${n}`, `0098${n}`])];
}

module.exports = {
  mapPersianDigits,
  digitsOnly,
  toNational10,
  toApiMobile,
  toLocal09,
  matchVariants,
};
