'use strict';

/**
 * Optional live SMS.ir smoke send with full trace logging.
 * Only sends when SMSIR_SMOKE_MOBILE is set (and SMSIR_DRY_RUN is not true).
 *
 * Usage:
 *   SMSIR_SMOKE_MOBILE=0912xxxxxxx yarn smsir:smoke
 */

require('dotenv').config();

const smsir = require('../src/channels/smsir');
const { sendSms } = require('../src/channels');
const { toApiMobile } = require('../src/utils/iranMobile');
const { newTraceId, log, maskMobile } = require('../src/utils/log');

async function main() {
  const mobile = String(process.env.SMSIR_SMOKE_MOBILE || '').trim();
  const traceId = newTraceId();

  if (!mobile) {
    console.log('SMSIR_SMOKE_MOBILE not set — skipping live send (safe no-op).');
    console.log('Set SMSIR_SMOKE_MOBILE=09xxxxxxxxx to send one test SMS.');
    process.exit(0);
  }

  if (smsir.getConfig().dryRun) {
    console.log('SMSIR_DRY_RUN=true — refusing live smoke send.');
    process.exit(0);
  }

  if (!smsir.isConfigured()) {
    console.error('SMS.ir not configured (SMSIR_API_KEY / SMSIR_LINE_NUMBER).');
    process.exit(1);
  }

  const apiMobile = toApiMobile(mobile);
  if (!apiMobile) {
    console.error('Invalid SMSIR_SMOKE_MOBILE');
    process.exit(1);
  }

  log.info({
    traceId,
    step: 'smoke_start',
    mobileMasked: maskMobile(mobile),
    apiMobileFormat: apiMobile,
    lineNumber: smsir.getConfig().lineNumber,
    baseUrl: smsir.getConfig().baseUrl,
    dryRun: false,
  });

  const result = await sendSms({
    to: mobile,
    content: `clinic-reminder smoke ${traceId.slice(0, 8)}`,
    traceId,
  });

  log.info({
    traceId,
    step: 'smoke_done',
    providerMessageId: result.providerMessageId,
    providerPackId: result.providerPackId,
    dryRun: Boolean(result.dryRun),
  });

  console.log(
    JSON.stringify(
      {
        traceId,
        providerMessageId: result.providerMessageId,
        providerPackId: result.providerPackId,
        raw: result.raw,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        smokeFailed: true,
        traceId: err.traceId || null,
        message: err.message || String(err),
        code: err.code || null,
        smsirStatus: err.smsirStatus != null ? err.smsirStatus : null,
        body: err.body || null,
      },
      null,
      2
    )
  );
  process.exit(1);
});
