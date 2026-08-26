import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveResetExpiry, resolveResetPeriodDays } from '../lib/reset-user-usage.js';

test('usage reset keeps the stored subscription period stable', () => {
  assert.equal(
    resolveResetPeriodDays({ subscriptionPeriodDays: 30, createdAt: '2026-01-01', expiresAt: '2026-12-31' }),
    30
  );
});

test('legacy users derive their period from the current period start', () => {
  assert.equal(
    resolveResetPeriodDays({ periodStartedAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-07-31T00:00:00.000Z' }),
    30
  );
});

test('an explicit reset duration takes priority', () => {
  assert.equal(resolveResetPeriodDays({ subscriptionPeriodDays: 30 }, 90), 90);
});

test('usage reset replaces 15 remaining days with a fresh 30-day period', () => {
  const resetAt = new Date('2026-07-22T00:00:00.000Z');
  assert.deepEqual(
    resolveResetExpiry(
      { subscriptionPeriodDays: 30, expiresAt: '2026-08-06T00:00:00.000Z' },
      undefined,
      resetAt
    ),
    { expiresAt: '2026-08-21T00:00:00.000Z', expiresAtUnchanged: false }
  );
});

test('an explicit reset duration intentionally creates a new expiration date', () => {
  const resetAt = new Date('2026-07-22T00:00:00.000Z');
  assert.deepEqual(
    resolveResetExpiry({ expiresAt: '2026-08-06T00:00:00.000Z' }, 30, resetAt),
    { expiresAt: '2026-08-21T00:00:00.000Z', expiresAtUnchanged: false }
  );
});
