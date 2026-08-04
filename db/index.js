'use strict';

const { query } = require('./pool');
const patients = require('./models/patients');
const patientChannelIdentities = require('./models/patientChannelIdentities');
const appointments = require('./models/appointments');
const messages = require('./models/messages');
const reminderAttempts = require('./models/reminderAttempts');
const activityLog = require('./models/activityLog');
const clinicSettings = require('./models/clinicSettings');

module.exports = {
  query,
  patients,
  patientChannelIdentities,
  appointments,
  messages,
  reminderAttempts,
  activityLog,
  clinicSettings,
};
