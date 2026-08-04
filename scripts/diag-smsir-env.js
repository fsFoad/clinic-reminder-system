'use strict';

/**
 * Safe SMS.ir env + request-shape diagnostic (never prints API key).
 * Usage: node -r dotenv/config scripts/diag-smsir-env.js
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const env = {};
for (const line of raw.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  let v = t.slice(i + 1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  env[t.slice(0, i).trim()] = v;
}

const line = String(env.SMSIR_LINE_NUMBER || process.env.SMSIR_LINE_NUMBER || '').trim();
const key = String(env.SMSIR_API_KEY || process.env.SMSIR_API_KEY || '').trim();
const base = String(env.SMSIR_BASE_URL || process.env.SMSIR_BASE_URL || 'https://api.sms.ir/v1').replace(
  /\/$/,
  ''
);
const dry = String(env.SMSIR_DRY_RUN || process.env.SMSIR_DRY_RUN || '').toLowerCase();

console.log('SMSIR_LINE_NUMBER=', JSON.stringify(line));
console.log('SMSIR_LINE_NUMBER as Number=', Number(line));
console.log('Number.isSafeInteger(line)=', Number.isSafeInteger(Number(line)));
console.log('SMSIR_BASE_URL=', base);
console.log('SMSIR_DRY_RUN=', dry);
console.log('SMSIR_API_KEY present=', Boolean(key), 'len=', key.length);

const payload = {
  lineNumber: Number(line || 0),
  messageText: 'clinic-reminder diag — ignore',
  mobiles: ['9120000000'],
  sendDateTime: null,
};
console.log('Would POST body shape=', JSON.stringify(payload));

if (!key || !line || ['1', 'true', 'yes'].includes(dry)) {
  console.log('Skipping live probe (missing key/line or dry-run).');
  process.exit(0);
}

(async () => {
  const url = `${base}/send/bulk`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-api-key': key,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { rawText: text.slice(0, 300) };
  }
  // Never echo headers/key
  console.log('Live probe HTTP status=', res.status);
  console.log('Live probe body=', JSON.stringify(parsed));
})().catch((err) => {
  console.error('Probe failed:', err.message);
  process.exit(1);
});
