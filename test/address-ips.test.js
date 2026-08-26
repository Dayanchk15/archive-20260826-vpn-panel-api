import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveConnectAddressIp,
  resolveUserServerAddressIp,
  userUsesServerAddressIp,
} from '../lib/address-ips.js';

test('a per-user server IP overrides only the matching server', () => {
  const user = {
    serverAddressIps: {
      bunny: '94.20.154.22',
    },
  };
  const bunny = { id: 'bunny', addressIp: '138.199.37.232' };
  const relay = { id: 'relay', addressIp: '216.58.198.46' };

  assert.equal(resolveUserServerAddressIp(user, bunny), '94.20.154.22');
  assert.equal(userUsesServerAddressIp(user, bunny), true);
  assert.equal(resolveConnectAddressIp(user, bunny, 0, {}), '94.20.154.22');
  assert.equal(resolveConnectAddressIp(user, relay, 1, {}), '216.58.198.46');
});
