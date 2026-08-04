'use strict';

const { withTransaction } = require('../../db/pool');
const patients = require('../../db/models/patients');
const patientChannelIdentities = require('../../db/models/patientChannelIdentities');
const appointments = require('../../db/models/appointments');
const activityLog = require('../../db/models/activityLog');
const clinicSettings = require('./clinicSettings');
const { CHANNELS, APPOINTMENT_STATUS, EVENT_TYPE } = require('../constants');
const { toLocal09 } = require('../utils/iranMobile');

const ALLOWED_APPOINTMENT_STATUSES = new Set(Object.values(APPOINTMENT_STATUS));

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

function normalizeUserId(userId) {
  const id = String(userId == null ? '' : userId).trim();
  if (!id) throw badRequest('userId is required');
  return id.slice(0, 64);
}

/** Normalize PG date / ISO string → YYYY-MM-DD. */
function toDateIso(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const mo = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  return null;
}

function normalizeChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw badRequest('at least one channel is required');
  }
  for (const ch of channels) {
    if (!ch.channel || !CHANNELS.includes(ch.channel)) {
      throw badRequest(`unsupported channel: ${ch.channel}`);
    }
    if (!ch.externalId || !String(ch.externalId).trim()) {
      throw badRequest(`externalId required for channel ${ch.channel}`);
    }
  }
  const preferredCount = channels.filter((c) => c.isPreferred).length;
  if (preferredCount > 1) {
    throw badRequest('only one preferred channel allowed');
  }
  return channels.map((ch, i) => {
    let externalId = String(ch.externalId).trim();
    if (ch.channel === 'sms') {
      externalId = toLocal09(externalId) || externalId;
    }
    return {
      channel: ch.channel,
      externalId,
      isPreferred: preferredCount === 0 ? i === 0 : Boolean(ch.isPreferred),
    };
  });
}

/** Create patient + channel identities only (no appointment). */
async function registerPatient({ patient, channels, userId }) {
  const uid = normalizeUserId(userId);
  if (!patient?.name || !String(patient.name).trim()) {
    throw badRequest('patient.name is required');
  }
  const normalizedChannels = normalizeChannels(channels);

  return withTransaction(async (client) => {
    const createdPatient = await patients.create(
      {
        name: String(patient.name).trim(),
        notes: patient.notes != null ? String(patient.notes).trim() || null : null,
        userId: uid,
      },
      client
    );

    const createdChannels = [];
    for (const ch of normalizedChannels) {
      createdChannels.push(
        await patientChannelIdentities.create(
          {
            patientId: createdPatient.id,
            channel: ch.channel,
            externalId: ch.externalId,
            isPreferred: ch.isPreferred,
            userId: uid,
          },
          client
        )
      );
    }

    return { patient: createdPatient, channels: createdChannels };
  });
}

/** Update patient name/notes and upsert channel identities (same tenant only). */
async function updatePatient(patientId, { patient, channels, userId }) {
  const uid = normalizeUserId(userId);
  const id = Number(patientId);
  if (!id) throw badRequest('patientId is required');
  if (!patient?.name || !String(patient.name).trim()) {
    throw badRequest('patient.name is required');
  }
  const normalizedChannels = normalizeChannels(channels);

  const existing = await patients.findById(id, { userId: uid });
  if (!existing) throw notFound(`patient ${id} not found`);

  return withTransaction(async (client) => {
    const updatedPatient = await patients.update(
      id,
      {
        name: String(patient.name).trim(),
        notes: patient.notes != null ? String(patient.notes).trim() || null : null,
        userId: uid,
      },
      client
    );

    const existingChannels = await patientChannelIdentities.findByPatientId(id, client);
    const byChannel = new Map(existingChannels.map((c) => [c.channel, c]));
    const keptChannels = new Set();
    const resultChannels = [];

    for (const ch of normalizedChannels) {
      keptChannels.add(ch.channel);
      const prev = byChannel.get(ch.channel);
      if (prev) {
        resultChannels.push(
          await patientChannelIdentities.update(
            prev.id,
            { externalId: ch.externalId, isPreferred: ch.isPreferred },
            client
          )
        );
      } else {
        resultChannels.push(
          await patientChannelIdentities.create(
            {
              patientId: id,
              channel: ch.channel,
              externalId: ch.externalId,
              isPreferred: ch.isPreferred,
              userId: uid,
            },
            client
          )
        );
      }
    }

    for (const prev of existingChannels) {
      if (!keptChannels.has(prev.channel)) {
        await patientChannelIdentities.remove(prev.id, client);
      }
    }

    const preferred = resultChannels.find((c) => c.is_preferred) || resultChannels[0];
    if (preferred) {
      await patientChannelIdentities.setPreferred(preferred.id, client);
    }

    const finalChannels = await patientChannelIdentities.findByPatientId(id, client);
    return { patient: updatedPatient, channels: finalChannels };
  });
}

/** Create appointment for an existing patient (must belong to same user). */
async function createAppointment({ patientId, appointment, userId }) {
  const uid = normalizeUserId(userId);
  const id = Number(patientId);
  if (!id) throw badRequest('patientId is required');
  if (!appointment?.appointmentDate || !appointment?.appointmentTime) {
    throw badRequest('appointment.appointmentDate and appointmentTime are required');
  }

  const settings = await clinicSettings.getSettings(uid);
  const { date, time } = clinicSettings.assertWithinWorkingHours(
    appointment.appointmentDate,
    appointment.appointmentTime,
    { settings }
  );

  const existing = await patients.findById(id, { userId: uid });
  if (!existing) throw notFound(`patient ${id} not found`);

  const createdAppointment = await appointments.create({
    patientId: id,
    appointmentDate: date,
    appointmentTime: time,
    visitType:
      appointment.visitType != null ? String(appointment.visitType).trim() || null : null,
    status: 'scheduled',
    userId: uid,
  });

  await activityLog.create({
    appointmentId: createdAppointment.id,
    eventType: EVENT_TYPE.MANUAL_OVERRIDE,
    details: { action: 'appointment_created', patient_id: id },
    userId: uid,
  });

  return { patient: existing, appointment: createdAppointment };
}

/** Fetch one appointment + patient (with channels), same tenant only. */
async function getAppointment(appointmentId, { userId }) {
  const uid = normalizeUserId(userId);
  const id = Number(appointmentId);
  if (!id) throw badRequest('appointmentId is required');

  const appointment = await appointments.findById(id, { userId: uid });
  if (!appointment) throw notFound(`appointment ${id} not found`);

  const patient = await patients.findWithChannels(appointment.patient_id, { userId: uid });
  return { patient, appointment };
}

/**
 * Update appointment datetime / visit type / status (same tenant only).
 * Re-validates working hours whenever date or time is involved.
 */
async function updateAppointment(appointmentId, { appointment: body, userId }) {
  const uid = normalizeUserId(userId);
  const id = Number(appointmentId);
  if (!id) throw badRequest('appointmentId is required');

  const existing = await appointments.findById(id, { userId: uid });
  if (!existing) throw notFound(`appointment ${id} not found`);

  const patch = body || {};
  const nextDateRaw =
    patch.appointmentDate ?? patch.appointment_date ?? toDateIso(existing.appointment_date);
  const nextTimeRaw =
    patch.appointmentTime ?? patch.appointment_time ?? existing.appointment_time;

  const settings = await clinicSettings.getSettings(uid);
  const { date, time } = clinicSettings.assertWithinWorkingHours(nextDateRaw, nextTimeRaw, {
    settings,
  });

  let nextPatientId = existing.patient_id;
  const patientIdRaw = patch.patientId ?? patch.patient_id;
  if (patientIdRaw != null && patientIdRaw !== '') {
    const pid = Number(patientIdRaw);
    if (!pid) throw badRequest('patientId is invalid');
    if (pid !== Number(existing.patient_id)) {
      const patientOk = await patients.findById(pid, { userId: uid });
      if (!patientOk) throw notFound(`patient ${pid} not found`);
      nextPatientId = pid;
    }
  }

  const fields = {
    userId: uid,
    appointmentDate: date,
    appointmentTime: time,
  };

  if (patch.visitType !== undefined || patch.visit_type !== undefined) {
    const vt = patch.visitType ?? patch.visit_type;
    fields.visitType = vt != null ? String(vt).trim() || null : null;
  }

  if (patch.status !== undefined && patch.status !== null && patch.status !== '') {
    const status = String(patch.status).trim();
    if (!ALLOWED_APPOINTMENT_STATUSES.has(status)) {
      throw badRequest(`unsupported status: ${status}`);
    }
    fields.status = status;
  }

  if (Number(nextPatientId) !== Number(existing.patient_id)) {
    fields.patientId = nextPatientId;
  }

  const updated = await appointments.update(id, fields);
  if (!updated) throw notFound(`appointment ${id} not found`);

  await activityLog.create({
    appointmentId: id,
    eventType: EVENT_TYPE.MANUAL_OVERRIDE,
    details: {
      action: 'appointment_updated',
      before: {
        patient_id: existing.patient_id,
        appointment_date: toDateIso(existing.appointment_date),
        appointment_time: clinicSettings.normalizeTimeHhmm(existing.appointment_time),
        visit_type: existing.visit_type,
        status: existing.status,
      },
      after: {
        patient_id: updated.patient_id,
        appointment_date: toDateIso(updated.appointment_date),
        appointment_time: clinicSettings.normalizeTimeHhmm(updated.appointment_time),
        visit_type: updated.visit_type,
        status: updated.status,
      },
    },
    userId: uid,
  });

  const patient = await patients.findWithChannels(updated.patient_id, { userId: uid });
  return { patient, appointment: updated };
}

/**
 * Convenience: patient + channels + appointment in one txn.
 * Prefer registerPatient + createAppointment for separated UI flows.
 */
async function registerIntake({ patient, channels, appointment, userId }) {
  const uid = normalizeUserId(userId);
  if (!appointment?.appointmentDate || !appointment?.appointmentTime) {
    throw badRequest('appointment.appointmentDate and appointmentTime are required');
  }

  const settings = await clinicSettings.getSettings(uid);
  const { date, time } = clinicSettings.assertWithinWorkingHours(
    appointment.appointmentDate,
    appointment.appointmentTime,
    { settings }
  );

  return withTransaction(async (client) => {
    const { patient: createdPatient, channels: createdChannels } = await (async () => {
      if (!patient?.name || !String(patient.name).trim()) {
        throw badRequest('patient.name is required');
      }
      const normalizedChannels = normalizeChannels(channels);
      const p = await patients.create(
        {
          name: String(patient.name).trim(),
          notes: patient.notes != null ? String(patient.notes).trim() || null : null,
          userId: uid,
        },
        client
      );
      const chs = [];
      for (const ch of normalizedChannels) {
        chs.push(
          await patientChannelIdentities.create(
            {
              patientId: p.id,
              channel: ch.channel,
              externalId: ch.externalId,
              isPreferred: ch.isPreferred,
              userId: uid,
            },
            client
          )
        );
      }
      return { patient: p, channels: chs };
    })();

    const createdAppointment = await appointments.create(
      {
        patientId: createdPatient.id,
        appointmentDate: date,
        appointmentTime: time,
        visitType:
          appointment.visitType != null ? String(appointment.visitType).trim() || null : null,
        status: 'scheduled',
        userId: uid,
      },
      client
    );

    await activityLog.create(
      {
        appointmentId: createdAppointment.id,
        eventType: EVENT_TYPE.MANUAL_OVERRIDE,
        details: {
          action: 'intake_registered',
          patient_id: createdPatient.id,
          channels: createdChannels.map((c) => c.channel),
        },
        userId: uid,
      },
      client
    );

    return {
      patient: createdPatient,
      channels: createdChannels,
      appointment: createdAppointment,
    };
  });
}

module.exports = {
  registerPatient,
  updatePatient,
  createAppointment,
  getAppointment,
  updateAppointment,
  registerIntake,
};
