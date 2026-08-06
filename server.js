'use strict';

require('dotenv').config();
const { createApp } = require('./src/app');
const reminderService = require('./src/services/reminderService');
const clinicSettings = require('./src/services/clinicSettings');
const smsInboundPoller = require('./src/services/smsInboundPoller');
const smsir = require('./src/channels/smsir');

const port = Number(process.env.PORT || 3000);
const app = createApp();

app.listen(port, () => {
  console.log(`clinic-reminder-system listening on :${port}`);
  // Best-effort one-time JSON → admin user import (no-op if already migrated).
  clinicSettings.migrateLegacyJsonOnce().catch(() => {});
  startReminderScheduler();
  startSmsirInboundPoller();
});

/**
 * Built-in poller for auto reminders.
 * REMINDER_CRON_MS=0 or unset-with-disable → off
 * Default: 60000 (every minute) when REMINDER_CRON_ENABLED=true or REMINDER_CRON_MS>0
 */
function startReminderScheduler() {
  const enabledFlag = String(process.env.REMINDER_CRON_ENABLED || '').toLowerCase();
  const msRaw = process.env.REMINDER_CRON_MS;
  let intervalMs = msRaw != null && msRaw !== '' ? Number(msRaw) : NaN;

  if (enabledFlag === 'false' || enabledFlag === '0') {
    console.log('[reminders] scheduler disabled (REMINDER_CRON_ENABLED=false)');
    return;
  }

  if (!Number.isFinite(intervalMs)) {
    // Default on when enabled flag is true, else default 60s when neither set → enable by default
    if (enabledFlag === 'true' || enabledFlag === '1' || msRaw == null || msRaw === '') {
      intervalMs = 60_000;
    }
  }

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.log('[reminders] scheduler disabled (REMINDER_CRON_MS<=0)');
    return;
  }

  const minMs = 15_000;
  if (intervalMs < minMs) intervalMs = minMs;

  console.log(
    `[reminders] scheduler every ${intervalMs}ms · per-user offsets from clinic_settings`
  );

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const report = await reminderService.processDueReminders();
      if (report.sent > 0) {
        console.log(
          `[reminders] sent=${report.sent} scanned=${report.scanned} users=${report.users}`,
          report.results.map((r) => `${r.appointmentId}@${r.offsetHours}h(u${r.userId})`).join(', ')
        );
      }
    } catch (err) {
      console.error('[reminders] scheduler error:', err.message || err);
    } finally {
      running = false;
    }
  };

  // First tick shortly after boot, then interval.
  setTimeout(tick, 5_000);
  setInterval(tick, intervalMs);
}

/**
 * SMS.ir inbound poller (no webhook). Default every 5 minutes.
 * SMSIR_POLL_ENABLED=false to disable. SMSIR_POLL_MS overrides interval.
 */
function startSmsirInboundPoller() {
  const enabledFlag = String(process.env.SMSIR_POLL_ENABLED || 'true').toLowerCase();
  if (enabledFlag === 'false' || enabledFlag === '0') {
    console.log('[smsir] inbound poller disabled (SMSIR_POLL_ENABLED=false)');
    return;
  }

  if (!smsir.isConfigured()) {
    console.log('[smsir] inbound poller idle — set SMSIR_API_KEY and SMSIR_LINE_NUMBER');
    return;
  }

  let intervalMs = Number(process.env.SMSIR_POLL_MS);
  // Default 60s so inbound replies reach the dashboard quickly (SSE pushes UI after poll).
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) intervalMs = 60_000;
  const minMs = 30_000;
  if (intervalMs < minMs) intervalMs = minMs;

  console.log(`[smsir] inbound poller every ${intervalMs}ms (receive/latest + pack delivery)`);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const report = await smsInboundPoller.pollOnce();
      const inbound = report.inbound || {};
      const delivery = report.delivery || {};
      if ((inbound.processed || 0) > 0 || (delivery.updated || 0) > 0) {
        console.log(
          `[smsir] inbound processed=${inbound.processed || 0} fetched=${inbound.fetched || 0}` +
            ` · delivery updated=${delivery.updated || 0}`
        );
      }
    } catch (err) {
      console.error('[smsir] poller error:', err.message || err);
    } finally {
      running = false;
    }
  };

  // First tick soon after boot so inbound replies aren't stuck waiting a full interval.
  setTimeout(tick, 5_000);
  setInterval(tick, intervalMs);
}
