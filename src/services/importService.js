'use strict';

const XLSX = require('xlsx');
const patientChannelIdentities = require('../../db/models/patientChannelIdentities');
const patients = require('../../db/models/patients');
const appointments = require('../../db/models/appointments');
const intakeService = require('./intakeService');
const clinicSettings = require('./clinicSettings');
const { toLocal09 } = require('../utils/iranMobile');

const MODES = Object.freeze([
  'patient_and_appointment',
  'patients_only',
  'appointments_only',
]);

const HEADER_ALIASES = Object.freeze({
  name: ['name', 'نام', 'patient', 'patient_name', 'بیمار', 'مراجع', 'مراجع کننده', 'مراجع‌کننده'],
  phone: ['phone', 'mobile', 'sms', 'tel', 'telephone', 'موبایل', 'شماره'],
  bale_id: ['bale_id', 'bale', 'baleid', 'بله'],
  preferred: ['preferred', 'preferred_channel', 'کانال', 'channel'],
  appointment_date: ['appointment_date', 'date', 'تاریخ', 'appointmentdate'],
  appointment_time: ['appointment_time', 'time', 'ساعت', 'appointmenttime'],
  visit_type: ['visit_type', 'visit', 'type', 'نوع', 'visittype'],
  notes: ['notes', 'note', 'یادداشت'],
  patient_id: ['patient_id', 'patientid', 'id', 'شناسه'],
});

const TEMPLATE_HEADERS = [
  'name',
  'phone',
  'bale_id',
  'preferred',
  'appointment_date',
  'appointment_time',
  'visit_type',
  'notes',
  'patient_id',
];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\w\u0600-\u06FF]+/g, '');
}

function mapHeaderToKey(header) {
  const n = normalizeHeader(header);
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((a) => normalizeHeader(a) === n || n === key)) return key;
  }
  return null;
}

function cellStr(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

function normalizeDate(v) {
  const s = cellStr(v);
  if (!s) return '';
  // Excel serial date
  if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 20000 && Number(s) < 80000) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(excelEpoch.getTime() + Number(s) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  return s;
}

function normalizeTime(v) {
  const s = cellStr(v);
  if (!s) return '';
  // Excel fraction of day
  if (/^\d+(\.\d+)?$/.test(s) && Number(s) < 1) {
    const total = Math.round(Number(s) * 24 * 60);
    const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  return s;
}

function mapRawRow(raw) {
  return {
    name: cellStr(raw.name),
    phone: cellStr(raw.phone).replace(/\s+/g, ''),
    bale_id: cellStr(raw.bale_id),
    preferred: cellStr(raw.preferred).toLowerCase() || '',
    appointment_date: normalizeDate(raw.appointment_date),
    appointment_time: normalizeTime(raw.appointment_time),
    visit_type: cellStr(raw.visit_type),
    notes: cellStr(raw.notes),
    patient_id: cellStr(raw.patient_id),
  };
}

function parseSheetMatrix(matrix) {
  if (!matrix?.length) return [];
  const headerRow = matrix[0].map((h) => mapHeaderToKey(h));
  const rows = [];
  for (let i = 1; i < matrix.length; i++) {
    const line = matrix[i] || [];
    const allEmpty = line.every((c) => cellStr(c) === '');
    if (allEmpty) continue;
    const raw = {};
    headerRow.forEach((key, idx) => {
      if (!key) return;
      raw[key] = line[idx];
    });
    rows.push({ rowNumber: i + 1, raw, mapped: mapRawRow(raw) });
  }
  return rows;
}

function parseExcelBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw badRequest('excel file has no sheets');
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  return parseSheetMatrix(matrix);
}

async function parsePdfBuffer(buffer) {
  const { PDFParse } = require('pdf-parse');
  let parser;
  let text = '';
  let tableMatrix = null;

  try {
    parser = new PDFParse({ data: buffer });
    try {
      const tables = await parser.getTable();
      const first =
        tables?.mergedTables?.[0] ||
        tables?.pages?.find((p) => p.tables?.length)?.tables?.[0];
      if (Array.isArray(first) && first.length >= 2) {
        tableMatrix = first;
      }
    } catch {
      /* fall through to text */
    }
    if (!tableMatrix) {
      const textResult = await parser.getText();
      text = (textResult?.text || '').trim();
    }
  } catch (e) {
    throw badRequest(`failed to parse PDF: ${e.message}`);
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  if (tableMatrix) {
    return parseSheetMatrix(tableMatrix);
  }

  if (text.length < 20) {
    throw badRequest(
      'PDF has little or no extractable text (scanned/image PDF). OCR is not supported yet — use Excel or a text PDF.'
    );
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let headerIdx = -1;
  let headerKeys = [];
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const parts = splitPdfLine(lines[i]);
    const keys = parts.map((p) => mapHeaderToKey(p));
    const known = keys.filter(Boolean).length;
    if (known >= 2) {
      headerIdx = i;
      headerKeys = keys;
      break;
    }
  }

  if (headerIdx < 0) {
    throw badRequest(
      'could not find a header row in PDF. Expected columns like: name, phone, appointment_date, …'
    );
  }

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const parts = splitPdfLine(lines[i]);
    if (parts.every((p) => !p)) continue;
    const raw = {};
    headerKeys.forEach((key, idx) => {
      if (!key) return;
      raw[key] = parts[idx];
    });
    rows.push({ rowNumber: i + 1, raw, mapped: mapRawRow(raw) });
  }
  return rows;
}

function splitPdfLine(line) {
  if (line.includes('\t')) return line.split('\t').map((s) => s.trim());
  if (line.includes('|')) return line.split('|').map((s) => s.trim());
  return line.split(/\s{2,}/).map((s) => s.trim());
}

async function resolvePatientId(mapped, userId) {
  if (mapped.patient_id && /^\d+$/.test(mapped.patient_id)) {
    const id = Number(mapped.patient_id);
    const p = await patients.findById(id, { userId });
    return p ? id : null;
  }
  if (mapped.phone) {
    const phone = toLocal09(mapped.phone) || mapped.phone;
    const row = await patientChannelIdentities.findByChannelExternalId('sms', phone, {
      userId,
    });
    if (row) return row.patient_id;
  }
  if (mapped.bale_id) {
    const row = await patientChannelIdentities.findByChannelExternalId('bale', mapped.bale_id, {
      userId,
    });
    if (row) return row.patient_id;
  }
  return null;
}

function buildChannels(mapped) {
  const channels = [];
  if (mapped.phone) {
    const phone = toLocal09(mapped.phone) || mapped.phone;
    channels.push({ channel: 'sms', externalId: phone, isPreferred: false });
  }
  if (mapped.bale_id) {
    channels.push({ channel: 'bale', externalId: mapped.bale_id, isPreferred: false });
  }
  if (!channels.length) return channels;

  const pref = mapped.preferred === 'sms' || mapped.preferred === 'bale' ? mapped.preferred : null;
  if (pref) {
    channels.forEach((c) => {
      c.isPreferred = c.channel === pref;
    });
  } else {
    channels[0].isPreferred = true;
  }
  return channels;
}

/**
 * Field / patient-match checks only (no hours or capacity).
 */
async function validateRowBasics(mode, mapped, userId) {
  const errors = [];
  let matchPatientId = null;

  if (mode === 'patients_only' || mode === 'patient_and_appointment') {
    if (!mapped.name) errors.push('name is required');
    const channels = buildChannels(mapped);
    if (!channels.length) errors.push('phone or bale_id is required');
  }

  if (mode === 'patient_and_appointment' || mode === 'appointments_only') {
    if (!mapped.appointment_date) errors.push('appointment_date is required');
    if (!mapped.appointment_time) errors.push('appointment_time is required');
    if (mapped.appointment_date && !/^\d{4}-\d{2}-\d{2}$/.test(mapped.appointment_date)) {
      errors.push('appointment_date must be YYYY-MM-DD');
    }
    if (mapped.appointment_time && !/^\d{2}:\d{2}$/.test(mapped.appointment_time)) {
      errors.push('appointment_time must be HH:mm');
    }
  }

  if (mode === 'appointments_only') {
    matchPatientId = await resolvePatientId(mapped, userId);
    if (!matchPatientId) {
      errors.push('could not match existing patient (patient_id / phone / bale_id)');
    }
  }

  return { errors, matchPatientId };
}

/**
 * Hard hours check for appointment rows. Mutates `errors` with DAY_CLOSED / OUTSIDE_HOURS messages.
 */
function appendHoursErrors(mapped, errors, settings) {
  if (!mapped.appointment_date || !mapped.appointment_time) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mapped.appointment_date)) return;
  if (!/^\d{2}:\d{2}$/.test(mapped.appointment_time)) return;
  try {
    clinicSettings.assertWithinWorkingHours(mapped.appointment_date, mapped.appointment_time, {
      settings,
    });
  } catch (err) {
    if (err.code === 'DAY_CLOSED') {
      errors.push('Clinic is closed on this date');
    } else if (err.code === 'OUTSIDE_HOURS') {
      errors.push(err.message || 'Appointment time is outside clinic hours');
    } else {
      errors.push(err.message || 'Invalid appointment hours');
    }
  }
}

/**
 * Soft capacity warn: already-booked + earlier valid rows in this batch for the same date.
 * Does not invalidate the row.
 */
function appendCapacityWarning(mapped, warnings, settings, bookedByDate, batchCountByDate) {
  if (!mapped.appointment_date || !/^\d{4}-\d{2}-\d{2}$/.test(mapped.appointment_date)) return;
  const date = mapped.appointment_date;
  const hours = clinicSettings.resolveHoursForDate(date, settings);
  const capacity = clinicSettings.capacityFromHours(hours, settings.sessionDurationMinutes);
  const booked = bookedByDate.get(date) || 0;
  const pendingInBatch = batchCountByDate.get(date) || 0;
  const after = booked + pendingInBatch + 1;
  if (capacity > 0 && after > capacity) {
    warnings.push(
      `Day capacity would be exceeded (${after}/${capacity} including this import batch)`
    );
  }
}

async function loadBookedByDate(dates, userId) {
  const map = new Map();
  for (const date of dates) {
    if (!date || map.has(date)) continue;
    try {
      map.set(date, await appointments.countActiveByDate(date, { userId }));
    } catch {
      map.set(date, 0);
    }
  }
  return map;
}

async function previewFromBuffer({ buffer, filename, mode, userId }) {
  if (!MODES.includes(mode)) throw badRequest(`unsupported mode: ${mode}`);

  const lower = String(filename || '').toLowerCase();
  let parsed;
  if (lower.endsWith('.pdf')) {
    parsed = await parsePdfBuffer(buffer);
  } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv')) {
    parsed = parseExcelBuffer(buffer);
  } else {
    // sniff PDF magic
    if (buffer.slice(0, 4).toString() === '%PDF') {
      parsed = await parsePdfBuffer(buffer);
    } else {
      parsed = parseExcelBuffer(buffer);
    }
  }

  const needsAppt = mode === 'patient_and_appointment' || mode === 'appointments_only';
  const settings = needsAppt ? await clinicSettings.getSettings(userId) : null;
  const dateSet = new Set();
  if (needsAppt) {
    for (const item of parsed) {
      const d = item.mapped?.appointment_date;
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) dateSet.add(d);
    }
  }
  const bookedByDate = needsAppt ? await loadBookedByDate(dateSet, userId) : new Map();
  const batchCountByDate = new Map();

  const rows = [];
  for (const item of parsed) {
    const { errors, matchPatientId } = await validateRowBasics(mode, item.mapped, userId);
    const warnings = [];
    if (needsAppt && settings) {
      appendHoursErrors(item.mapped, errors, settings);
      if (errors.length === 0) {
        appendCapacityWarning(item.mapped, warnings, settings, bookedByDate, batchCountByDate);
        const d = item.mapped.appointment_date;
        batchCountByDate.set(d, (batchCountByDate.get(d) || 0) + 1);
      }
    }
    const valid = errors.length === 0;
    rows.push({
      rowNumber: item.rowNumber,
      raw: item.raw,
      mapped: item.mapped,
      errors,
      warnings,
      valid,
      matchPatientId,
      selected: valid,
    });
  }

  return { mode, rows, total: rows.length, validCount: rows.filter((r) => r.valid).length };
}

async function commitRows({ mode, rows, userId }) {
  if (!MODES.includes(mode)) throw badRequest(`unsupported mode: ${mode}`);
  if (!Array.isArray(rows) || !rows.length) throw badRequest('rows required');

  const needsAppt = mode === 'patient_and_appointment' || mode === 'appointments_only';
  const settings = needsAppt ? await clinicSettings.getSettings(userId) : null;

  const results = [];
  let created = 0;
  let failed = 0;

  for (const row of rows) {
    const mapped = mapRawRow(row.mapped || row);
    const { errors, matchPatientId } = await validateRowBasics(mode, mapped, userId);
    if (needsAppt && settings) {
      appendHoursErrors(mapped, errors, settings);
    }
    if (errors.length) {
      failed += 1;
      results.push({ ok: false, errors, mapped });
      continue;
    }

    try {
      if (mode === 'patients_only') {
        const result = await intakeService.registerPatient({
          patient: { name: mapped.name, notes: mapped.notes || null },
          channels: buildChannels(mapped),
          userId,
        });
        created += 1;
        results.push({ ok: true, patientId: result.patient.id });
      } else if (mode === 'appointments_only') {
        const result = await intakeService.createAppointment({
          patientId: matchPatientId,
          appointment: {
            appointmentDate: mapped.appointment_date,
            appointmentTime: mapped.appointment_time,
            visitType: mapped.visit_type || null,
          },
          userId,
        });
        created += 1;
        results.push({
          ok: true,
          patientId: matchPatientId,
          appointmentId: result.appointment.id,
        });
      } else {
        const result = await intakeService.registerIntake({
          patient: { name: mapped.name, notes: mapped.notes || null },
          channels: buildChannels(mapped),
          appointment: {
            appointmentDate: mapped.appointment_date,
            appointmentTime: mapped.appointment_time,
            visitType: mapped.visit_type || null,
          },
          userId,
        });
        created += 1;
        results.push({
          ok: true,
          patientId: result.patient.id,
          appointmentId: result.appointment.id,
        });
      }
    } catch (err) {
      failed += 1;
      const msg =
        err.code === 'DAY_CLOSED'
          ? 'Clinic is closed on this date'
          : err.code === 'OUTSIDE_HOURS'
            ? err.message
            : err.message;
      results.push({
        ok: false,
        errors: [msg],
        code: err.code || undefined,
        mapped,
      });
    }
  }

  return { mode, created, failed, results };
}

function buildTemplateBuffer() {
  const sample = [
    TEMPLATE_HEADERS,
    [
      'مریم احمدی',
      '09121234501',
      '10001',
      'bale',
      '2026-08-10',
      '09:30',
      'پیگیری تغذیه',
      'نمونه',
      '',
    ],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(sample);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  MODES,
  TEMPLATE_HEADERS,
  previewFromBuffer,
  commitRows,
  buildTemplateBuffer,
  parseExcelBuffer,
  parsePdfBuffer,
};
