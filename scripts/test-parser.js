'use strict';

const assert = require('assert');
const { parsePatientResponse, normalizeText } = require('../src/services/responseParser');

function check(label, input, expectedIntent) {
  const result = parsePatientResponse(input);
  assert.strictEqual(
    result.intent,
    expectedIntent,
    `${label}: expected ${expectedIntent}, got ${result.intent} (${result.normalized})`
  );
}

check('confirm exact', 'تایید شود', 'confirm');
check('confirm spaced', '  تایید   شود  ', 'confirm');
check('confirm quotes', '«تایید شود»', 'confirm');
check('confirm digit', '2', 'confirm');
check('confirm persian digit', '۲', 'confirm');
check('confirm ok', 'ok', 'confirm');
check('confirm miyam', 'میام', 'confirm');
check('reschedule', 'جابجا شود', 'reschedule');
check('cancel', 'کنسل شود', 'cancel');
check('cancel digit', '1', 'cancel');
check('cancel cancel', 'cancel', 'cancel');
check('cancel nemiyam', 'نمیام', 'cancel');
check('unknown emoji', '👍', 'unknown');
check('unknown free text', 'فردا میام؟', 'unknown');

assert.ok(normalizeText('تاييد').includes('تایید') || normalizeText('تاييد') === 'تایید');

console.log('responseParser tests passed');
