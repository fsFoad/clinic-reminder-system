'use strict';

/**
 * Unit/smoke tests for SMS.ir client request shaping + mobile normalization.
 * Mocks global fetch — does not hit the network.
 */

const assert = require('assert');
const iranMobile = require('../src/utils/iranMobile');

process.env.SMSIR_API_KEY = 'test-key-not-real';
process.env.SMSIR_LINE_NUMBER = '30002108030582';
process.env.SMSIR_BASE_URL = 'https://api.sms.ir/v1';
process.env.SMSIR_DRY_RUN = 'false';

const smsir = require('../src/channels/smsir');
const { sendSms } = require('../src/channels');

assert.strictEqual(iranMobile.toApiMobile('09121234567'), '9121234567');
assert.strictEqual(iranMobile.toApiMobile('+989121234567'), '9121234567');
assert.strictEqual(iranMobile.toLocal09('9121234567'), '09121234567');
assert.ok(iranMobile.matchVariants('09121234567').includes('9121234567'));
assert.ok(iranMobile.matchVariants('9121234567').includes('09121234567'));

const calls = [];
global.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status: 1,
        message: 'موفق',
        data: {
          packId: 'pack-test-1',
          messageIds: [998877],
          cost: 1.5,
        },
      });
    },
  };
};

(async () => {
  const like = await smsir.sendLikeToLike({
    messageTexts: ['hello'],
    mobiles: ['9121234567'],
    sendDateTime: null,
  });
  assert.strictEqual(like.data.packId, 'pack-test-1');
  assert.strictEqual(like.data.messageIds[0], 998877);

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.includes('/send/likeToLike'));
  const headers = calls[0].init.headers;
  assert.strictEqual(headers['X-API-KEY'], 'test-key-not-real');
  assert.strictEqual(headers['x-api-key'], 'test-key-not-real');
  assert.strictEqual(headers.Accept, 'text/plain');
  const body = JSON.parse(calls[0].init.body);
  assert.strictEqual(body.lineNumber, 30002108030582);
  assert.deepStrictEqual(body.mobiles, ['9121234567']);
  assert.deepStrictEqual(body.messageTexts, ['hello']);
  assert.strictEqual(body.sendDateTime, null);

  const sent = await sendSms({ to: '09121234567', content: 'reminder body' });
  assert.strictEqual(sent.providerMessageId, '998877');
  assert.strictEqual(sent.providerPackId, 'pack-test-1');
  assert.ok(calls[calls.length - 1].url.includes('/send/likeToLike'));
  assert.ok(!JSON.stringify(sent.raw).includes('test-key-not-real'));

  // Error mapping: 401 → our 502
  global.fetch = async () => ({
    ok: false,
    status: 401,
    async text() {
      return JSON.stringify({ status: 401, message: 'unauthorized' });
    },
  });
  await assert.rejects(
    () => smsir.sendLikeToLike({ messageTexts: ['x'], mobiles: ['9121234567'] }),
    (err) => {
      assert.strictEqual(err.httpStatus, 401);
      assert.strictEqual(err.status, 502);
      return true;
    }
  );

  // SMS.ir 123 (line needs activation) → our 502 with code, not validation 400
  global.fetch = async () => ({
    ok: false,
    status: 400,
    async text() {
      return JSON.stringify({
        status: 123,
        message: 'خط ارسال‌کننده نیاز به فعال‌سازی دارد.',
      });
    },
  });
  await assert.rejects(
    () => smsir.sendLikeToLike({ messageTexts: ['x'], mobiles: ['9121234567'] }),
    (err) => {
      assert.strictEqual(err.smsirStatus, 123);
      assert.strictEqual(err.code, 'smsir_123');
      assert.strictEqual(err.status, 502);
      assert.match(err.message, /فعال‌سازی/);
      return true;
    }
  );

  // Blacklist: messageId 0
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status: 1,
        message: 'موفق',
        data: { packId: 'p', messageIds: [0], cost: 0 },
      });
    },
  });
  await assert.rejects(() => sendSms({ to: '09120000000', content: 'x' }), (err) => {
    assert.strictEqual(err.code, 'smsir_blacklist');
    return true;
  });

  // Docs sample pack/ids must not count as a real send
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status: 1,
        message: 'موفق',
        data: {
          packId: '2b99e63c-9bf8-4a21-9bfe-3f72dc1b46f1',
          messageIds: [86522023, 86522024],
          cost: 2,
        },
      });
    },
  });
  await assert.rejects(() => sendSms({ to: '09121234567', content: 'x' }), (err) => {
    assert.strictEqual(err.code, 'smsir_docs_sample');
    assert.strictEqual(err.status, 502);
    return true;
  });

  // Dry-run skips network
  process.env.SMSIR_DRY_RUN = 'true';
  let dryFetchCalled = false;
  global.fetch = async () => {
    dryFetchCalled = true;
    throw new Error('should not fetch');
  };
  const dry = await smsir.sendLikeToLike({
    messageTexts: ['dry'],
    mobiles: ['9121234567'],
  });
  assert.strictEqual(dry._dryRun, true);
  assert.ok(String(dry.data.packId).startsWith('dry-pack-'));
  assert.strictEqual(dryFetchCalled, false);

  console.log('smsir client tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
