'use strict';

/**
 * Live probe: DNS/TCP + curl + Node likeToLike to api.sms.ir.
 * Never prints the API key.
 */

require('dotenv').config();
const dns = require('dns').promises;
const net = require('net');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { toApiMobile } = require('../src/utils/iranMobile');
const { sendSms } = require('../src/channels');
const smsir = require('../src/channels/smsir');
const { newTraceId, maskMobile } = require('../src/utils/log');

function keyMeta(key) {
  const k = String(key || '');
  return { present: Boolean(k), len: k.length, prefix4: k.slice(0, 4), suffix4: k.slice(-4) };
}

function tcpProbe(host, port, ms = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      const remote = `${socket.remoteAddress}:${socket.remotePort}`;
      socket.end();
      resolve({ ok: true, remote });
    });
    socket.setTimeout(ms);
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    socket.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

async function main() {
  const cfg = smsir.getConfig();
  const mobileIn = String(process.env.SMSIR_SMOKE_MOBILE || '09195607793').trim();
  const apiMobile = toApiMobile(mobileIn);
  const traceId = newTraceId();
  const host = new URL(cfg.baseUrl).hostname;

  console.log('=== ENV (safe) ===');
  console.log(
    JSON.stringify(
      {
        dryRun: cfg.dryRun,
        lineNumber: cfg.lineNumber,
        baseUrl: cfg.baseUrl,
        host,
        endpoint: '/send/likeToLike',
        apiKey: keyMeta(cfg.apiKey),
        mobileMasked: maskMobile(mobileIn),
        apiMobileFormat: apiMobile,
        traceId,
      },
      null,
      2
    )
  );

  if (cfg.dryRun) {
    console.error('ABORT: SMSIR_DRY_RUN=true');
    process.exit(2);
  }

  console.log('=== DNS ===');
  const looked = await dns.lookup(host, { all: true });
  console.log(JSON.stringify(looked, null, 2));

  console.log('=== TCP :443 ===');
  console.log(JSON.stringify(await tcpProbe(looked[0].address, 443), null, 2));

  const body = JSON.stringify({
    lineNumber: Number(cfg.lineNumber),
    messageTexts: [`curl-likeToLike ${traceId.slice(0, 8)}`],
    mobiles: [apiMobile],
    sendDateTime: null,
  });

  console.log('=== CURL POST /send/likeToLike ===');
  console.log('request body (no key):', body);

  const curl = spawnSync(
    'curl.exe',
    [
      '-sS',
      '-w',
      '\n__CURL_META__ http_code=%{http_code} remote_ip=%{remote_ip} url_effective=%{url_effective}\n',
      '-X',
      'POST',
      `${cfg.baseUrl}/send/likeToLike`,
      '-H',
      'Content-Type: application/json',
      '-H',
      'Accept: text/plain',
      '-H',
      `X-API-KEY: ${cfg.apiKey}`,
      '-d',
      body,
    ],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }
  );

  if (curl.error) {
    console.error('curl spawn error', curl.error.message);
    process.exit(1);
  }
  const out = String(curl.stdout || '').replace(cfg.apiKey, '[redacted]');
  console.log(out);
  if (String(curl.stderr || '').trim()) {
    console.error('curl stderr:', String(curl.stderr).replace(cfg.apiKey, '[redacted]'));
  }

  let curlJson = null;
  try {
    curlJson = JSON.parse(out.split('\n__CURL_META__')[0].trim());
  } catch {
    curlJson = null;
  }
  console.log('=== CURL PARSED ===');
  console.log(JSON.stringify(curlJson, null, 2));

  const msgId = curlJson?.data?.messageIds?.[0];
  if (msgId) {
    console.log('=== CURL GET /send/{messageId} ===');
    const st = spawnSync(
      'curl.exe',
      [
        '-sS',
        '-w',
        '\n__CURL_META__ http_code=%{http_code} remote_ip=%{remote_ip}\n',
        `${cfg.baseUrl}/send/${msgId}`,
        '-H',
        'Accept: text/plain',
        '-H',
        `X-API-KEY: ${cfg.apiKey}`,
      ],
      { encoding: 'utf8' }
    );
    console.log(String(st.stdout || '').replace(cfg.apiKey, '[redacted]'));
  }

  console.log('=== NODE sendSms → likeToLike ===');
  const nodeTrace = randomUUID();
  try {
    const result = await sendSms({
      to: mobileIn,
      content: `node-likeToLike ${nodeTrace.slice(0, 8)}`,
      traceId: nodeTrace,
    });
    console.log(
      JSON.stringify(
        {
          nodeTrace,
          providerMessageId: result.providerMessageId,
          providerPackId: result.providerPackId,
          dryRun: result.dryRun,
          raw: result.raw,
        },
        null,
        2
      )
    );
    if (result.providerMessageId) {
      const status = await smsir.getSendStatus(result.providerMessageId, { traceId: nodeTrace });
      console.log('=== NODE getSendStatus ===');
      console.log(JSON.stringify(status, null, 2));
    }
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          nodeFailed: true,
          nodeTrace,
          message: err.message,
          code: err.code,
          smsirStatus: err.smsirStatus,
          body: err.body,
        },
        null,
        2
      )
    );
  }

  console.log('=== PANEL HINT ===');
  console.log(
    JSON.stringify(
      {
        lookForPackId: curlJson?.data?.packId || null,
        lookForMessageId: msgId || null,
        lineNumber: cfg.lineNumber,
        note: 'Refresh sms.ir sends report for this line; sample pack 2b99e63c… is docs-only.',
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
