import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRelaySubscriptionServer,
  shouldAutoAssignRelayServer,
} from '../lib/relay-subscription.js';

test('assigned pilot can remain eligible without being auto-assigned to new clients', () => {
  const server = {
    id: 'tm-fr2-fastly-h3',
    subscriptionEligible: true,
    addToNewClients: false,
  };

  assert.equal(isRelaySubscriptionServer(server), true);
  assert.equal(shouldAutoAssignRelayServer(server), false);
});
