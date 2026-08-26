import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeExtraSubscriptionLines,
  normalizeExtraSubscriptionLines,
  removeExtraSubscriptionLine,
  renameExtraSubscriptionLine,
  syncExtraSubscriptionFiles,
} from '../lib/extra-subscription-lines.js';

test('global extra links stay ordered and de-duplicated', () => {
  assert.deepEqual(
    mergeExtraSubscriptionLines([' vless://one ', 'vless://one'], ['ss://two', 'vless://one']),
    ['vless://one', 'ss://two']
  );
  assert.deepEqual(normalizeExtraSubscriptionLines([null, '', '  ', 'ss://two']), ['ss://two']);
});

test('remove and rename use the authoritative global index', () => {
  const links = ['vless://one#Old', 'ss://two#Two'];
  assert.deepEqual(removeExtraSubscriptionLine(links, 0), ['ss://two#Two']);
  assert.deepEqual(renameExtraSubscriptionLine(links, 1, '🇫🇷 France BN'), [
    'vless://one#Old',
    `ss://two#${encodeURIComponent('🇫🇷 France BN')}`,
  ]);
});

test('subscription synchronization is awaited and reports individual failures', async () => {
  const rebuilt = [];
  const result = await syncExtraSubscriptionFiles(
    [{ id: 'u1', name: 'One' }, { id: 'u2', name: 'Two' }],
    {
      concurrency: 2,
      reloadUser: async (id) => ({ id, extraSubscriptionLines: ['vless://ready'] }),
      upsertSubscriptionFile: async (user) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (user.id === 'u2') throw new Error('storage unavailable');
        rebuilt.push(user.id);
      },
    }
  );

  assert.deepEqual(rebuilt, ['u1']);
  assert.equal(result.requested, 2);
  assert.equal(result.refreshed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].userId, 'u2');
});
