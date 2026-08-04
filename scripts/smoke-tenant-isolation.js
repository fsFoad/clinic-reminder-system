'use strict';

/**
 * Smoke-test multi-tenant isolation + per-user message templates.
 * Usage: node scripts/smoke-tenant-isolation.js [baseUrl]
 */
require('dotenv').config();

const BASE = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 3000}`;

async function req(method, path, { userId = '1', body = null } = {}) {
  const headers = {
    Authorization: `Bearer mock-${userId}`,
    Accept: 'application/json',
  };
  let payload;
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log('BASE', BASE);

  const health = await req('GET', '/api/health', { userId: '1' });
  assert(health.status === 200 && health.json?.ok, 'health failed');
  console.log('✓ health');

  // --- patients isolation ---
  const list1 = await req('GET', '/api/patients', { userId: '1' });
  assert(list1.status === 200 && Array.isArray(list1.json), 'patients u1 list failed');
  const count1Before = list1.json.length;
  console.log(`✓ patients user1 count=${count1Before}`);

  const list2Before = await req('GET', '/api/patients', { userId: '2' });
  assert(list2Before.status === 200 && Array.isArray(list2Before.json), 'patients u2 list failed');
  const count2Before = list2Before.json.length;
  console.log(`✓ patients user2 count=${count2Before}`);

  const created = await req('POST', '/api/patients', {
    userId: '2',
    body: {
      patient: { name: 'کاربر دو تست', notes: 'tenant-2' },
      channels: [{ channel: 'sms', externalId: '09129990002', isPreferred: true }],
    },
  });
  assert(created.status === 201 && created.json?.patient?.id, `create u2 patient failed: ${JSON.stringify(created)}`);
  const p2Id = created.json.patient.id;
  console.log(`✓ created patient for user2 id=${p2Id}`);

  const list2After = await req('GET', '/api/patients', { userId: '2' });
  assert(list2After.json.length === count2Before + 1, 'user2 should see new patient');
  assert(
    list2After.json.some((p) => p.id === p2Id),
    'user2 list missing new patient'
  );

  const list1After = await req('GET', '/api/patients', { userId: '1' });
  assert(list1After.json.length === count1Before, 'user1 patient count must not change');
  assert(!list1After.json.some((p) => p.id === p2Id), 'user1 must not see user2 patient');

  const crossGet = await req('GET', `/api/patients/${p2Id}`, { userId: '1' });
  assert(crossGet.status === 404, `cross-user patient get should be 404, got ${crossGet.status}`);
  console.log('✓ patients isolated (404 on cross-get)');

  // --- appointments isolation ---
  const sum1 = await req('GET', '/api/appointments/summary', { userId: '1' });
  const sum2 = await req('GET', '/api/appointments/summary', { userId: '2' });
  assert(Array.isArray(sum1.json) && Array.isArray(sum2.json), 'summary arrays');
  console.log(`✓ appointments summary user1=${sum1.json.length} user2=${sum2.json.length}`);

  // --- message template isolation ---
  const tpl1Get = await req('GET', '/api/settings/message-template', { userId: '1' });
  const tpl2Get = await req('GET', '/api/settings/message-template', { userId: '2' });
  assert(tpl1Get.status === 200 && tpl2Get.status === 200, 'template GET failed');

  const header1 = `قالب اختصاصی کاربر۱ {{visitType}}\n{{when}}\n\nلطفا حتما`;
  const header2 = `قالب اختصاصی کاربر۲ {{visitType}}\n{{when}}\n\nلطفا حتما`;

  const put1 = await req('PUT', '/api/settings/message-template', {
    userId: '1',
    body: { header: header1 },
  });
  assert(put1.status === 200 && put1.json.header === header1, `put u1 template failed ${JSON.stringify(put1)}`);

  const put2 = await req('PUT', '/api/settings/message-template', {
    userId: '2',
    body: { header: header2 },
  });
  assert(put2.status === 200 && put2.json.header === header2, `put u2 template failed ${JSON.stringify(put2)}`);

  const again1 = await req('GET', '/api/settings/message-template', { userId: '1' });
  const again2 = await req('GET', '/api/settings/message-template', { userId: '2' });
  assert(again1.json.header === header1, 'user1 template overwritten by user2');
  assert(again2.json.header === header2, 'user2 template not persisted');
  assert(again1.json.header !== again2.json.header, 'templates must differ');
  console.log('✓ message templates isolated per user');

  // --- cron uses per-user appointment sets ---
  const cron = await req('POST', '/api/cron/reminders', { userId: '1' });
  assert(cron.status === 200, `cron failed ${cron.status}`);
  assert(typeof cron.json.users === 'number', 'cron should report users');
  assert(Array.isArray(cron.json.byUser), 'cron byUser missing');
  console.log(
    `✓ cron reminders users=${cron.json.users} scanned=${cron.json.scanned} byUser=`,
    cron.json.byUser
  );

  console.log('\nALL SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err.message || err);
  process.exit(1);
});
