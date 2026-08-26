import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractExternalSubscriptionLinks,
  fetchExternalSubscription,
  summarizeExternalSubscriptionLinks,
} from '../lib/external-subscription-import.js';

test('extracts and de-duplicates supported plain subscription links', () => {
  const links = extractExternalSubscriptionLinks([
    'vless://one@example.com:443#One',
    'ss://cipher@example.com:443#Two',
    'vless://one@example.com:443#One',
    'https://not-a-vpn-link.example/',
  ].join('\n'));
  assert.deepEqual(links, [
    'vless://one@example.com:443#One',
    'ss://cipher@example.com:443#Two',
  ]);
});

test('decodes a base64 subscription body', () => {
  const body = Buffer.from('trojan://secret@example.com:443#Test\nvmess://encoded').toString('base64');
  assert.deepEqual(extractExternalSubscriptionLinks(body), [
    'trojan://secret@example.com:443#Test',
    'vmess://encoded',
  ]);
});

test('summarizes imported protocols', () => {
  assert.deepEqual(
    summarizeExternalSubscriptionLinks(['vless://a', 'vless://b', 'ss://c']),
    { total: 3, protocols: { vless: 2, ss: 1 } }
  );
});

test('rejects non-http subscription URLs before fetching', async () => {
  await assert.rejects(() => fetchExternalSubscription('file:///etc/passwd'), /Only HTTP or HTTPS/);
});

test('rejects credentials and non-standard ports', async () => {
  await assert.rejects(() => fetchExternalSubscription('https://user:pass@example.com/sub'), /Credentials/);
  await assert.rejects(() => fetchExternalSubscription('https://example.com:8443/sub'), /ports 80 and 443/);
});
