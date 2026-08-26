import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCountryKey, sortServersGroupedByCountry } from '../lib/subscription-sort.js';

test('transport suffixes do not split the same country into separate groups', () => {
  assert.equal(normalizeCountryKey({ country: 'France CF' }), 'france');
  assert.equal(normalizeCountryKey({ country: 'France BN XHTTP TEST' }), 'france');
  assert.equal(normalizeCountryKey({ country: 'USA BN' }), 'usa');
});

test('subscriptions are grouped alphabetically by country and transport', () => {
  const sorted = sortServersGroupedByCountry([
    { id: 'usa-run', country: 'USA', host: 'usa.run.app' },
    { id: 'fr-bn', country: 'France BN', host: 'fr.b-cdn.net', sortOrder: 11 },
    { id: 'de-run', country: 'Germany', host: 'de.run.app', sortOrder: 20 },
    { id: 'fr-cf', country: 'France CF', region: 'cloudflare-finalmask', sortOrder: 10 },
    { id: 'fr-run', country: 'France', host: 'fr.run.app', sortOrder: 12 },
  ]);

  assert.deepEqual(sorted.map((server) => server.id), [
    'fr-cf',
    'fr-bn',
    'fr-run',
    'de-run',
    'usa-run',
  ]);
});
