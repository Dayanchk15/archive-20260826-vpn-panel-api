import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoDisable } from '../lib/user-enforcement.js';

test('user is disabled at the exact expiry instant', () => {
  const now = Date.parse('2026-08-26T12:00:00.000Z');
  assert.equal(
    shouldAutoDisable({ status: 'active', expiresAt: '2026-08-26T12:00:00.000Z' }, now),
    'expired'
  );
});

test('user is disabled when upload plus download reaches the limit', () => {
  assert.equal(
    shouldAutoDisable({
      status: 'active',
      trafficLimitGB: 10,
      uploadUsedGB: 4,
      downloadUsedGB: 6,
    }),
    'traffic_exceeded'
  );
});

test('disabled users are not reclassified by the automatic limiter', () => {
  assert.equal(
    shouldAutoDisable({ status: 'disabled', trafficLimitGB: 1, trafficUsedGB: 5 }),
    null
  );
});
