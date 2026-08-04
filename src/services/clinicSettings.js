'use strict';

const fs = require('fs');
const path = require('path');
const { CHANNELS, DEFAULT_FALLBACK_HOURS } = require('../constants');
const clinicSettingsModel = require('../../db/models/clinicSettings');

/** Legacy JSON store — one-time import only; not used as live source after migrate. */
const LEGACY_STORE_PATH = path.join(__dirname, '../../data/clinic-settings.json');

/**
 * User id that receives the one-time JSON import (front admin = id 2).
 * Override with LEGACY_SETTINGS_USER_ID.
 */
function legacyImportUserId() {
  return String(process.env.LEGACY_SETTINGS_USER_ID || '2');
}

/** Default weekly routine: Sat–Wed 09–17, Thu 09–13, Fri closed (JS weekday: 0=Sun … 6=Sat). */
function dayHours(weekday, isClosed, intervals = []) {
  const ints = isClosed
    ? []
    : intervals.map((i) => ({ openTime: i.openTime, closeTime: i.closeTime }));
  return {
    weekday,
    isClosed: !!isClosed || ints.length === 0,
    intervals: ints,
    openTime: ints.length ? ints[0].openTime : null,
    closeTime: ints.length ? ints[ints.length - 1].closeTime : null,
  };
}

const DEFAULT_WEEKLY_HOURS = Object.freeze([
  dayHours(0, false, [{ openTime: '09:00', closeTime: '17:00' }]),
  dayHours(1, false, [{ openTime: '09:00', closeTime: '17:00' }]),
  dayHours(2, false, [{ openTime: '09:00', closeTime: '17:00' }]),
  dayHours(3, false, [{ openTime: '09:00', closeTime: '17:00' }]),
  dayHours(4, false, [{ openTime: '09:00', closeTime: '13:00' }]),
  dayHours(5, true, []),
  dayHours(6, false, [{ openTime: '09:00', closeTime: '17:00' }]),
]);

const DEFAULT_MESSAGE_TEMPLATE_HEADER = [
  'سلام وقت شما بخیر',
  'وقت مراجعه {{visitType}} شما :',
  '{{when}}',
  '',
  'لطفا حتما',
].join('\n');

const DEFAULTS = Object.freeze({
  defaultChannel: 'bale',
  enabledChannels: ['sms', 'bale', 'whatsapp', 'telegram'],
  reminderSendCount: 2,
  reminderOffsetsHours: [24, 4],
  fallbackAfterHours: DEFAULT_FALLBACK_HOURS,
  /** Length of one appointment session in minutes (used for day capacity). */
  sessionDurationMinutes: 30,
  weeklyHours: DEFAULT_WEEKLY_HOURS.map((d) => ({
    ...d,
    intervals: d.intervals.map((i) => ({ ...i })),
  })),
  dayExceptions: [],
  /** Editable reminder header (locked footer keywords stay in messageTemplate). */
  messageTemplateHeader: DEFAULT_MESSAGE_TEMPLATE_HEADER,
});

let legacyMigratePromise = null;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function normalizeUserId(userId) {
  const id = String(userId == null ? '' : userId).trim();
  if (!id) throw badRequest('userId is required for clinic settings');
  return id.slice(0, 64);
}

function normalizeOffsets(count, offsets) {
  const n = Math.min(5, Math.max(1, Number(count) || 1));
  let list = Array.isArray(offsets)
    ? offsets.map((h) => Number(h)).filter((h) => Number.isFinite(h) && h > 0)
    : [];
  if (!list.length) list = [...DEFAULTS.reminderOffsetsHours];
  while (list.length < n) {
    const last = list[list.length - 1] || 4;
    list.push(Math.max(1, Math.round(last / 2)));
  }
  list = list.slice(0, n).sort((a, b) => b - a);
  return { reminderSendCount: n, reminderOffsetsHours: list };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normalizeTime(value, field) {
  if (value == null || value === '') return null;
  const s = String(value).trim().slice(0, 5);
  if (!TIME_RE.test(s)) throw badRequest(`${field} must be HH:mm`);
  return s;
}

/** Accept intervals[] or legacy openTime/closeTime. */
function normalizeIntervals(raw, { allowEmpty = false } = {}) {
  let list = [];
  if (Array.isArray(raw?.intervals) && raw.intervals.length) {
    list = raw.intervals;
  } else if (raw?.openTime && raw?.closeTime) {
    list = [{ openTime: raw.openTime, closeTime: raw.closeTime }];
  }
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const openTime = normalizeTime(list[i]?.openTime, `intervals[${i}].openTime`);
    const closeTime = normalizeTime(list[i]?.closeTime, `intervals[${i}].closeTime`);
    if (!openTime || !closeTime) throw badRequest('interval openTime and closeTime required');
    if (openTime >= closeTime) throw badRequest('interval openTime must be before closeTime');
    out.push({ openTime, closeTime });
  }
  out.sort((a, b) => a.openTime.localeCompare(b.openTime));
  for (let i = 1; i < out.length; i++) {
    if (out[i].openTime < out[i - 1].closeTime) {
      throw badRequest('intervals must not overlap');
    }
  }
  if (!allowEmpty && !out.length) throw badRequest('at least one open interval required');
  return out;
}

function normalizeWeeklyHours(list) {
  if (!Array.isArray(list) || list.length !== 7) {
    throw badRequest('weeklyHours must be an array of 7 weekday entries');
  }
  const byDay = new Map();
  for (const raw of list) {
    const weekday = Number(raw?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw badRequest('weekday must be 0–6 (Sun–Sat)');
    }
    if (byDay.has(weekday)) throw badRequest(`duplicate weekday ${weekday}`);
    const isClosed = !!raw?.isClosed;
    const intervals = isClosed ? [] : normalizeIntervals(raw);
    byDay.set(weekday, dayHours(weekday, isClosed || !intervals.length, intervals));
  }
  if (byDay.size !== 7) throw badRequest('weeklyHours must cover all 7 weekdays');
  return [0, 1, 2, 3, 4, 5, 6].map((d) => byDay.get(d));
}

function normalizeException(raw) {
  const date = String(raw?.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('exception date must be YYYY-MM-DD');
  const isClosed = !!raw?.isClosed;
  const intervals = isClosed ? [] : normalizeIntervals(raw);
  const closed = isClosed || !intervals.length;
  const note = raw?.note != null ? String(raw.note).slice(0, 200) : '';
  return {
    date,
    isClosed: closed,
    intervals: closed ? [] : intervals,
    openTime: closed || !intervals.length ? null : intervals[0].openTime,
    closeTime: closed || !intervals.length ? null : intervals[intervals.length - 1].closeTime,
    note,
  };
}

function normalizeExceptions(list) {
  if (!Array.isArray(list)) throw badRequest('dayExceptions must be an array');
  const map = new Map();
  for (const item of list) {
    const ex = normalizeException(item);
    map.set(ex.date, ex);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeWeeklyFromStore(raw) {
  try {
    if (Array.isArray(raw) && raw.length === 7) return normalizeWeeklyHours(raw);
  } catch {
    /* fall through */
  }
  return DEFAULT_WEEKLY_HOURS.map((d) => ({
    ...d,
    intervals: d.intervals.map((i) => ({ ...i })),
  }));
}

function normalizeExceptionsFromStore(raw) {
  try {
    if (Array.isArray(raw)) return normalizeExceptions(raw);
  } catch {
    /* fall through */
  }
  return [];
}

function hydrateSettings(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const { reminderSendCount, reminderOffsetsHours } = normalizeOffsets(
    base.reminderSendCount,
    base.reminderOffsetsHours
  );
  const enabled = Array.isArray(base.enabledChannels)
    ? base.enabledChannels.filter((c) => CHANNELS.includes(c))
    : [...DEFAULTS.enabledChannels];
  const enabledChannels = enabled.length ? enabled : [...DEFAULTS.enabledChannels];
  let defaultChannel = String(base.defaultChannel || DEFAULTS.defaultChannel);
  if (!CHANNELS.includes(defaultChannel) || !enabledChannels.includes(defaultChannel)) {
    defaultChannel = enabledChannels[0];
  }
  const fallbackAfterHours = Math.min(
    72,
    Math.max(1, Number(base.fallbackAfterHours) || DEFAULTS.fallbackAfterHours)
  );
  const sessionDurationMinutes = Math.min(
    240,
    Math.max(5, Number(base.sessionDurationMinutes) || DEFAULTS.sessionDurationMinutes)
  );

  const messageTemplateHeader =
    base.messageTemplateHeader != null && String(base.messageTemplateHeader).trim()
      ? String(base.messageTemplateHeader)
      : DEFAULT_MESSAGE_TEMPLATE_HEADER;

  return {
    defaultChannel,
    enabledChannels,
    reminderSendCount,
    reminderOffsetsHours,
    fallbackAfterHours,
    sessionDurationMinutes,
    weeklyHours: normalizeWeeklyFromStore(base.weeklyHours),
    dayExceptions: normalizeExceptionsFromStore(base.dayExceptions),
    messageTemplateHeader,
    availableChannels: [...CHANNELS],
  };
}

function readLegacyJson() {
  try {
    if (!fs.existsSync(LEGACY_STORE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(LEGACY_STORE_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * One-time optional import of data/clinic-settings.json into LEGACY_SETTINGS_USER_ID
 * (default admin "2") when that user has no row yet.
 * Safe to call repeatedly — no-ops after first successful import or if JSON missing.
 */
async function migrateLegacyJsonOnce() {
  if (!legacyMigratePromise) {
    legacyMigratePromise = (async () => {
      const targetUser = legacyImportUserId();
      const existing = await clinicSettingsModel.findByUserId(targetUser);
      if (existing) {
        return { migrated: false, reason: 'target_user_already_has_settings', userId: targetUser };
      }
      const legacy = readLegacyJson();
      if (!legacy) {
        return { migrated: false, reason: 'no_legacy_json', userId: targetUser };
      }
      const hydrated = hydrateSettings({ ...DEFAULTS, ...legacy });
      await clinicSettingsModel.upsert(targetUser, {
        defaultChannel: hydrated.defaultChannel,
        enabledChannels: hydrated.enabledChannels,
        reminderSendCount: hydrated.reminderSendCount,
        reminderOffsetsHours: hydrated.reminderOffsetsHours,
        fallbackAfterHours: hydrated.fallbackAfterHours,
        sessionDurationMinutes: hydrated.sessionDurationMinutes,
        weeklyHours: hydrated.weeklyHours,
        dayExceptions: hydrated.dayExceptions,
        messageTemplateHeader: hydrated.messageTemplateHeader,
      });
      console.log(
        `[clinic-settings] migrated legacy JSON → user_id=${targetUser} (${LEGACY_STORE_PATH})`
      );
      return { migrated: true, userId: targetUser };
    })().catch((err) => {
      legacyMigratePromise = null;
      console.error('[clinic-settings] legacy JSON migrate failed:', err.message || err);
      return { migrated: false, reason: 'error', error: err.message || String(err) };
    });
  }
  return legacyMigratePromise;
}

async function persistCore(userId, next) {
  await clinicSettingsModel.upsert(userId, {
    defaultChannel: next.defaultChannel,
    enabledChannels: next.enabledChannels,
    reminderSendCount: next.reminderSendCount,
    reminderOffsetsHours: next.reminderOffsetsHours,
    fallbackAfterHours: next.fallbackAfterHours,
    sessionDurationMinutes: next.sessionDurationMinutes,
    weeklyHours: next.weeklyHours,
    dayExceptions: next.dayExceptions,
    messageTemplateHeader: next.messageTemplateHeader || DEFAULT_MESSAGE_TEMPLATE_HEADER,
  });
}

/**
 * Load settings for a user. First GET seeds DEFAULTS (does not affect other users).
 * @param {string|number} userId
 */
async function getSettings(userId) {
  const id = normalizeUserId(userId);
  await migrateLegacyJsonOnce();

  let row = await clinicSettingsModel.findByUserId(id);
  if (!row) {
    const seeded = hydrateSettings(DEFAULTS);
    await persistCore(id, seeded);
    row = await clinicSettingsModel.findByUserId(id);
  }

  return hydrateSettings(row);
}

/**
 * List users that already have a settings row (for cron).
 * Does not seed defaults.
 */
async function listSettingsUserIds() {
  await migrateLegacyJsonOnce();
  return clinicSettingsModel.listUserIds();
}

async function updateSettings(userId, patch = {}) {
  const id = normalizeUserId(userId);
  const current = await getSettings(id);
  const next = {
    ...current,
    weeklyHours: current.weeklyHours.map((d) => ({
      ...d,
      intervals: (d.intervals || []).map((i) => ({ ...i })),
    })),
    dayExceptions: current.dayExceptions.map((d) => ({
      ...d,
      intervals: (d.intervals || []).map((i) => ({ ...i })),
    })),
  };

  if (patch.enabledChannels != null) {
    if (!Array.isArray(patch.enabledChannels) || !patch.enabledChannels.length) {
      throw badRequest('enabledChannels must be a non-empty array');
    }
    next.enabledChannels = patch.enabledChannels.filter((c) => CHANNELS.includes(c));
    if (!next.enabledChannels.length) throw badRequest('at least one enabled channel required');
  }

  if (patch.defaultChannel != null) {
    const ch = String(patch.defaultChannel);
    if (!CHANNELS.includes(ch)) throw badRequest(`unsupported channel: ${ch}`);
    next.defaultChannel = ch;
  }

  if (patch.reminderSendCount != null || patch.reminderOffsetsHours != null) {
    const normalized = normalizeOffsets(
      patch.reminderSendCount != null ? patch.reminderSendCount : next.reminderSendCount,
      patch.reminderOffsetsHours != null ? patch.reminderOffsetsHours : next.reminderOffsetsHours
    );
    next.reminderSendCount = normalized.reminderSendCount;
    next.reminderOffsetsHours = normalized.reminderOffsetsHours;
  }

  if (patch.fallbackAfterHours != null) {
    const h = Number(patch.fallbackAfterHours);
    if (!Number.isFinite(h) || h < 1 || h > 72) {
      throw badRequest('fallbackAfterHours must be between 1 and 72');
    }
    next.fallbackAfterHours = h;
  }

  if (patch.sessionDurationMinutes != null) {
    const m = Number(patch.sessionDurationMinutes);
    if (!Number.isFinite(m) || m < 5 || m > 240) {
      throw badRequest('sessionDurationMinutes must be between 5 and 240');
    }
    next.sessionDurationMinutes = Math.round(m);
  }

  if (patch.weeklyHours != null) {
    next.weeklyHours = normalizeWeeklyHours(patch.weeklyHours);
  }

  if (patch.dayExceptions != null) {
    next.dayExceptions = normalizeExceptions(patch.dayExceptions);
  }

  if (!next.enabledChannels.includes(next.defaultChannel)) {
    next.defaultChannel = next.enabledChannels[0];
  }

  await persistCore(id, next);
  return getSettings(id);
}

/** Upsert one calendar-day exception without touching weekly routine or other settings. */
async function upsertDayException(userId, body = {}) {
  const id = normalizeUserId(userId);
  const current = await getSettings(id);
  const ex = normalizeException(body);
  const dayExceptions = current.dayExceptions.filter((d) => d.date !== ex.date);
  dayExceptions.push(ex);
  dayExceptions.sort((a, b) => a.date.localeCompare(b.date));
  await persistCore(id, { ...current, dayExceptions });
  return getSettings(id);
}

/** Remove exception for a date → day falls back to weekly routine. */
async function removeDayException(userId, date) {
  const id = normalizeUserId(userId);
  const current = await getSettings(id);
  const key = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw badRequest('date must be YYYY-MM-DD');
  const dayExceptions = current.dayExceptions.filter((d) => d.date !== key);
  await persistCore(id, { ...current, dayExceptions });
  return getSettings(id);
}

/**
 * Effective hours for a calendar date (exception overrides weekly routine).
 * @param {string} dateIso YYYY-MM-DD
 * @param {object} settings preloaded settings
 */
function resolveHoursForDate(dateIso, settings) {
  if (!settings) throw badRequest('settings required for resolveHoursForDate');
  const key = String(dateIso || '').slice(0, 10);
  const ex = settings.dayExceptions.find((d) => d.date === key);
  if (ex) {
    const intervals = Array.isArray(ex.intervals)
      ? ex.intervals.map((i) => ({ ...i }))
      : ex.openTime && ex.closeTime
        ? [{ openTime: ex.openTime, closeTime: ex.closeTime }]
        : [];
    return {
      date: key,
      source: 'exception',
      isClosed: !!ex.isClosed || !intervals.length,
      intervals,
      openTime: intervals.length ? intervals[0].openTime : null,
      closeTime: intervals.length ? intervals[intervals.length - 1].closeTime : null,
      note: ex.note || '',
    };
  }
  const [y, m, d] = key.split('-').map(Number);
  const weekday = new Date(y, m - 1, d, 12).getDay();
  const wh = settings.weeklyHours.find((x) => x.weekday === weekday);
  const intervals = wh
    ? Array.isArray(wh.intervals) && wh.intervals.length
      ? wh.intervals.map((i) => ({ ...i }))
      : wh.openTime && wh.closeTime
        ? [{ openTime: wh.openTime, closeTime: wh.closeTime }]
        : []
    : [];
  return {
    date: key,
    source: 'weekly',
    isClosed: !!wh?.isClosed || !intervals.length,
    intervals,
    openTime: intervals.length ? intervals[0].openTime : null,
    closeTime: intervals.length ? intervals[intervals.length - 1].closeTime : null,
    note: '',
  };
}

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function formatHoursLabel(hours) {
  if (!hours || hours.isClosed) return '—';
  const intervals = hours.intervals || [];
  if (!intervals.length) return '—';
  return intervals.map((i) => `${i.openTime}–${i.closeTime}`).join(', ');
}

/** Max bookable sessions = sum of floors over each open interval. */
function capacityFromHours(hours, sessionDurationMinutes) {
  if (!hours || hours.isClosed) return 0;
  const dur = Math.max(5, Number(sessionDurationMinutes) || DEFAULTS.sessionDurationMinutes);
  const intervals =
    Array.isArray(hours.intervals) && hours.intervals.length
      ? hours.intervals
      : hours.openTime && hours.closeTime
        ? [{ openTime: hours.openTime, closeTime: hours.closeTime }]
        : [];
  let total = 0;
  for (const iv of intervals) {
    const span = timeToMinutes(iv.closeTime) - timeToMinutes(iv.openTime);
    if (span > 0) total += Math.floor(span / dur);
  }
  return total;
}

/**
 * Day capacity snapshot (hours + max sessions). Caller supplies booked count.
 * @param {string} dateIso
 * @param {{ booked?: number, settings: object }} opts
 */
function getDayCapacity(dateIso, opts = {}) {
  if (!opts.settings) throw badRequest('settings required for getDayCapacity');
  const settings = opts.settings;
  const hours = resolveHoursForDate(dateIso, settings);
  const sessionDurationMinutes = settings.sessionDurationMinutes;
  const capacity = capacityFromHours(hours, sessionDurationMinutes);
  const booked = Math.max(0, Number(opts.booked) || 0);
  const remaining = Math.max(0, capacity - booked);
  return {
    date: hours.date,
    ...hours,
    sessionDurationMinutes,
    capacity,
    booked,
    remaining,
    overCapacity: booked >= capacity && capacity >= 0,
    wouldExceedAfterOne: booked + 1 > capacity,
  };
}

function normalizeTimeHhmm(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!m) return null;
  return `${String(m[1]).padStart(2, '0')}:${m[2]}`;
}

function minutesToTime(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Hard-block: appointment start must fall inside one of the day's open intervals
 * and the session must finish by that interval's closeTime.
 * @param {string} dateIso
 * @param {string} timeRaw HH:mm or HH:mm:ss
 * @param {{ settings: object }} opts
 */
function assertWithinWorkingHours(dateIso, timeRaw, opts = {}) {
  if (!opts.settings) throw badRequest('settings required for assertWithinWorkingHours');
  const settings = opts.settings;
  const key = String(dateIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw badRequest('appointmentDate must be YYYY-MM-DD');
  }
  const time = normalizeTimeHhmm(timeRaw);
  if (!time) throw badRequest('appointmentTime must be HH:mm');

  const hours = resolveHoursForDate(key, settings);
  const intervals = hours.intervals || [];
  if (hours.isClosed || !intervals.length) {
    const err = badRequest('Clinic is closed on this date');
    err.code = 'DAY_CLOSED';
    err.details = { date: key, source: hours.source };
    throw err;
  }

  const start = timeToMinutes(time);
  const dur = Math.max(5, Number(settings.sessionDurationMinutes) || DEFAULTS.sessionDurationMinutes);
  const fits = intervals.some((iv) => {
    const open = timeToMinutes(iv.openTime);
    const close = timeToMinutes(iv.closeTime);
    return start >= open && start + dur <= close;
  });

  if (!fits) {
    const label = formatHoursLabel(hours);
    const err = badRequest(`Appointment time ${time} is outside clinic hours ${label}`);
    err.code = 'OUTSIDE_HOURS';
    err.details = {
      date: key,
      time,
      intervals,
      openTime: hours.openTime,
      closeTime: hours.closeTime,
      sessionDurationMinutes: dur,
      source: hours.source,
    };
    throw err;
  }

  return { date: key, time, hours, sessionDurationMinutes: dur };
}

/**
 * Generate bookable start times for a date from open intervals ÷ session duration.
 * @param {string} dateIso
 * @param {{ bookedTimes?: string[], settings: object }} opts
 */
function getDaySlots(dateIso, opts = {}) {
  if (!opts.settings) throw badRequest('settings required for getDaySlots');
  const settings = opts.settings;
  const hours = resolveHoursForDate(dateIso, settings);
  const sessionDurationMinutes = settings.sessionDurationMinutes;
  const capacity = capacityFromHours(hours, sessionDurationMinutes);

  const bookedRaw = Array.isArray(opts.bookedTimes) ? opts.bookedTimes : [];
  const bookedStarts = new Set();
  const bookedIntervals = [];
  for (const raw of bookedRaw) {
    const t = normalizeTimeHhmm(raw);
    if (!t) continue;
    bookedStarts.add(t);
    const start = timeToMinutes(t);
    bookedIntervals.push({ start, end: start + sessionDurationMinutes });
  }

  /** @type {string[]} */
  const allSlots = [];
  /** @type {string[]} */
  const availableSlots = [];
  /** @type {string[]} */
  const bookedSlots = [];

  const intervals = hours.isClosed ? [] : hours.intervals || [];
  for (const iv of intervals) {
    const open = timeToMinutes(iv.openTime);
    const close = timeToMinutes(iv.closeTime);
    for (let t = open; t + sessionDurationMinutes <= close; t += sessionDurationMinutes) {
      const label = minutesToTime(t);
      allSlots.push(label);
      const slotEnd = t + sessionDurationMinutes;
      const exactTaken = bookedStarts.has(label);
      const overlaps = bookedIntervals.some((b) => t < b.end && slotEnd > b.start);
      if (exactTaken || overlaps) {
        bookedSlots.push(label);
      } else {
        availableSlots.push(label);
      }
    }
  }

  return {
    date: hours.date,
    source: hours.source,
    isClosed: hours.isClosed,
    intervals,
    openTime: hours.openTime,
    closeTime: hours.closeTime,
    note: hours.note,
    sessionDurationMinutes,
    capacity,
    bookedCount: bookedStarts.size,
    allSlots,
    availableSlots,
    bookedSlots,
  };
}

module.exports = {
  DEFAULTS,
  DEFAULT_MESSAGE_TEMPLATE_HEADER,
  DEFAULT_WEEKLY_HOURS,
  LEGACY_STORE_PATH,
  getSettings,
  listSettingsUserIds,
  updateSettings,
  upsertDayException,
  removeDayException,
  resolveHoursForDate,
  capacityFromHours,
  getDayCapacity,
  assertWithinWorkingHours,
  getDaySlots,
  normalizeTimeHhmm,
  migrateLegacyJsonOnce,
  legacyImportUserId,
  dayHours,
};