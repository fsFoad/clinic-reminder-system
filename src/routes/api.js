'use strict';

const express = require('express');
const multer = require('multer');
const db = require('../../db');
const reminderService = require('../services/reminderService');
const inboundService = require('../services/inboundService');
const intakeService = require('../services/intakeService');
const importService = require('../services/importService');
const { parsePatientResponse } = require('../services/responseParser');
const { getTemplate, updateTemplate } = require('../services/messageTemplate');
const clinicSettings = require('../services/clinicSettings');
const smsInboundPoller = require('../services/smsInboundPoller');
const smsir = require('../channels/smsir');
const { DEFAULT_FALLBACK_HOURS } = require('../constants');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

router.get('/health', (_req, res) => {
  const cfg = smsir.getConfig();
  res.json({
    ok: true,
    smsir: {
      configured: smsir.isConfigured(),
      dryRun: cfg.dryRun,
      pollEnabled: smsInboundPoller.pollEnabled(),
      // Never expose API key
      lineConfigured: Boolean(cfg.lineNumber),
    },
  });
});

// ---------------------------------------------------------------------------
// Message template settings (editable header + locked reply keywords)
// ---------------------------------------------------------------------------

router.get('/settings/message-template', async (req, res, next) => {
  try {
    res.json(await getTemplate(req.userId));
  } catch (err) {
    next(err);
  }
});

router.put('/settings/message-template', async (req, res, next) => {
  try {
    res.json(await updateTemplate(req.userId, { header: req.body?.header }));
  } catch (err) {
    next(err);
  }
});

router.get('/settings/clinic', async (req, res, next) => {
  try {
    res.json(await clinicSettings.getSettings(req.userId));
  } catch (err) {
    next(err);
  }
});

router.put('/settings/clinic', async (req, res, next) => {
  try {
    res.json(await clinicSettings.updateSettings(req.userId, req.body || {}));
  } catch (err) {
    next(err);
  }
});

/** Upsert one day exception (does not change weekly routine). */
router.put('/settings/clinic/exceptions', async (req, res, next) => {
  try {
    res.json(await clinicSettings.upsertDayException(req.userId, req.body || {}));
  } catch (err) {
    next(err);
  }
});

/** Remove exception → day uses weekly routine again. */
router.delete('/settings/clinic/exceptions/:date', async (req, res, next) => {
  try {
    res.json(await clinicSettings.removeDayException(req.userId, req.params.date));
  } catch (err) {
    next(err);
  }
});

/** Effective hours for a date (exception overrides weekly). */
router.get('/settings/clinic/hours/:date', async (req, res, next) => {
  try {
    const settings = await clinicSettings.getSettings(req.userId);
    res.json(clinicSettings.resolveHoursForDate(req.params.date, settings));
  } catch (err) {
    next(err);
  }
});

/** Day capacity: open window ÷ session duration vs booked appointments. */
router.get('/settings/clinic/capacity/:date', async (req, res, next) => {
  try {
    const date = String(req.params.date || '').slice(0, 10);
    const settings = await clinicSettings.getSettings(req.userId);
    const booked = await db.appointments.countActiveByDate(date, { userId: req.userId });
    res.json(clinicSettings.getDayCapacity(date, { booked, settings }));
  } catch (err) {
    next(err);
  }
});

/**
 * Free / booked time slots for a date (sessionDurationMinutes steps within effective hours).
 * Also available as GET /appointments/slots?date=YYYY-MM-DD.
 */
async function respondDaySlots(userId, dateRaw, res) {
  const date = String(dateRaw || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const err = new Error('date must be YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  const settings = await clinicSettings.getSettings(userId);
  const bookedTimes = await db.appointments.listActiveTimesByDate(date, { userId });
  res.json(clinicSettings.getDaySlots(date, { bookedTimes, settings }));
}

router.get('/settings/clinic/slots/:date', async (req, res, next) => {
  try {
    await respondDaySlots(req.userId, req.params.date, res);
  } catch (err) {
    next(err);
  }
});

router.get('/appointments/slots', async (req, res, next) => {
  try {
    await respondDaySlots(req.userId, req.query.date, res);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Import Excel / PDF
// ---------------------------------------------------------------------------

router.get('/import/template.xlsx', (_req, res, next) => {
  try {
    const buf = importService.buildTemplateBuffer();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="import-template.xlsx"');
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

router.post('/import/preview', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file?.buffer) {
      const err = new Error('file is required');
      err.status = 400;
      throw err;
    }
    const mode = String(req.body?.mode || 'patient_and_appointment');
    const result = await importService.previewFromBuffer({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mode,
      userId: req.userId,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/import/commit', async (req, res, next) => {
  try {
    const mode = String(req.body?.mode || 'patient_and_appointment');
    const rows = req.body?.rows;
    const result = await importService.commitRows({ mode, rows, userId: req.userId });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Patients (مراجعین) — independent of appointments
// ---------------------------------------------------------------------------

router.get('/patients', async (req, res, next) => {
  try {
    const rows = await db.patients.listDirectory({
      userId: req.userId,
      q: req.query.q ? String(req.query.q) : null,
      limit: Number(req.query.limit || 200),
      offset: Number(req.query.offset || 0),
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/patients/:id', async (req, res, next) => {
  try {
    const row = await db.patients.findWithChannels(Number(req.params.id), {
      userId: req.userId,
    });
    if (!row) {
      res.status(404).json({ error: 'patient_not_found' });
      return;
    }
    const appts = await db.appointments.findByPatientId(row.id, { userId: req.userId });
    res.json({ ...row, appointments: appts });
  } catch (err) {
    next(err);
  }
});

/** Create patient + channels only */
router.post('/patients', async (req, res, next) => {
  try {
    const result = await intakeService.registerPatient({
      ...(req.body || {}),
      userId: req.userId,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/** Update patient + channels */
router.put('/patients/:id', async (req, res, next) => {
  try {
    const result = await intakeService.updatePatient(Number(req.params.id), {
      ...(req.body || {}),
      userId: req.userId,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Appointments (نوبت‌ها) — always linked via patient_id
// ---------------------------------------------------------------------------

/** Create appointment for an existing patient */
router.post('/appointments', async (req, res, next) => {
  try {
    const body = req.body || {};
    const patientId = body.patientId ?? body.patient_id;
    const appointment = body.appointment || {
      appointmentDate: body.appointmentDate ?? body.appointment_date,
      appointmentTime: body.appointmentTime ?? body.appointment_time,
      visitType: body.visitType ?? body.visit_type,
    };
    const result = await intakeService.createAppointment({
      patientId,
      appointment,
      userId: req.userId,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/appointments/summary', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const truthy = (v) => v === true || v === 'true' || v === '1';
    const rows = await db.appointments.getStatusSummary({
      userId: req.userId,
      startDate,
      endDate,
      awaitingSend: truthy(req.query.awaitingSend),
      awaitingReply: truthy(req.query.awaitingReply),
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/appointments/pending-no-response', async (req, res, next) => {
  try {
    const settings = await clinicSettings.getSettings(req.userId);
    const hours = Number(req.query.hours || settings.fallbackAfterHours || DEFAULT_FALLBACK_HOURS);
    const rows = await db.appointments.findWithoutResponseOlderThan(hours, {
      userId: req.userId,
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** Single appointment (tenant-scoped). Must stay before /:id/remind. */
router.get('/appointments/:id', async (req, res, next) => {
  try {
    const result = await intakeService.getAppointment(Number(req.params.id), {
      userId: req.userId,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Update datetime / visit type / status (tenant-scoped). */
router.put('/appointments/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const appointment = body.appointment || body;
    const result = await intakeService.updateAppointment(Number(req.params.id), {
      appointment,
      userId: req.userId,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Log of outbound reminder sends */
router.get('/reminders', async (req, res, next) => {
  try {
    const rows = await db.messages.listOutboundReminders({
      userId: req.userId,
      limit: Number(req.query.limit || 200),
      offset: Number(req.query.offset || 0),
      channel: req.query.channel ? String(req.query.channel) : null,
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/appointments/:id/remind', async (req, res, next) => {
  const { newTraceId, log } = require('../utils/log');
  const traceId = newTraceId();
  res.setHeader('X-Trace-Id', traceId);
  try {
    const channel = req.body?.channel || null;
    log.info({
      traceId,
      step: 'api_remind_received',
      appointmentId: Number(req.params.id),
      userId: req.userId != null ? String(req.userId) : null,
      channel: channel || null,
    });
    const result = await reminderService.sendReminder(Number(req.params.id), {
      channel,
      userId: req.userId,
      traceId,
    });
    res.setHeader('X-Trace-Id', result.traceId || traceId);
    res.status(201).json({ ...result, traceId: result.traceId || traceId });
  } catch (err) {
    err.traceId = err.traceId || traceId;
    next(err);
  }
});

/** Legacy combined intake (patient + appointment). Prefer POST /patients + POST /appointments. */
router.post('/intake', async (req, res, next) => {
  try {
    const result = await intakeService.registerIntake({
      ...(req.body || {}),
      userId: req.userId,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/cron/fallbacks', async (req, res, next) => {
  try {
    const hoursOverride =
      req.body?.hours != null && req.body.hours !== '' ? Number(req.body.hours) : null;
    const results = await reminderService.processFallbacks({ hours: hoursOverride });
    res.json({ hours: hoursOverride, results });
  } catch (err) {
    next(err);
  }
});

/** Auto-send reminders due by each user's clinicSettings.reminderOffsetsHours. */
router.post('/cron/reminders', async (req, res, next) => {
  try {
    const report = await reminderService.processDueReminders();
    res.json(report);
  } catch (err) {
    next(err);
  }
});

/** Poll SMS.ir receive/latest (+ optional pack delivery updates). */
router.post('/cron/smsir-inbound', async (req, res, next) => {
  try {
    const report = await smsInboundPoller.pollOnce();
    res.json(report);
  } catch (err) {
    next(err);
  }
});

router.post('/webhooks/inbound', async (req, res, next) => {
  try {
    const { channel, externalId, external_id, content, providerMessageId, provider_message_id } =
      req.body || {};
    const result = await inboundService.handleInboundMessage({
      channel,
      externalId: externalId || external_id,
      content,
      providerMessageId: providerMessageId || provider_message_id || null,
    });
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/webhooks/delivery', async (req, res, next) => {
  try {
    const {
      providerMessageId,
      provider_message_id,
      deliveryStatus,
      delivery_status,
      deliveredAt,
      sentAt,
      raw,
    } = req.body || {};
    const result = await inboundService.handleDeliveryWebhook({
      providerMessageId: providerMessageId || provider_message_id,
      deliveryStatus: deliveryStatus || delivery_status,
      deliveredAt: deliveredAt || null,
      sentAt: sentAt || null,
      raw: raw || null,
    });
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/dev/parse', (req, res) => {
  res.json(parsePatientResponse(req.body?.content));
});

module.exports = router;
