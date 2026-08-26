import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHiddifyAndroidProfileFromData,
  buildHiddifyAndroidTransport,
  hiddifyAndroidCountryCode,
  isHiddifyAndroidServerSupported,
} from '../lib/hiddify-android-profile.js';

const uuid = '11111111-2222-4333-8444-555555555555';
const server = {
  id: 'de-1',
  name: 'Germany #1',
  country: 'Germany',
  host: 'node.example.com',
  port: 443,
  protocol: 'vless',
  network: 'ws',
  security: 'tls',
  path: '/vpn',
  sni: 'www.google.com',
  enabled: true,
  hiddifyAndroidEnabled: true,
  hiddifyAndroidPriority: 10,
};

test('managed Hiddify profile only includes independently enabled servers', () => {
  const profile = buildHiddifyAndroidProfileFromData(
    [server, { ...server, id: 'hidden', hiddifyAndroidEnabled: false }],
    { connectionMode: 'direct', hiddifyAndroidProfileRefreshHours: 6 },
    1,
    uuid
  );
  assert.equal(profile.servers.length, 1);
  assert.equal(profile.servers[0].transport.uuid, uuid);
  assert.equal(profile.servers[0].transport.host, 'node.example.com');
  assert.equal(profile.refreshAfterSeconds, 21600);
  assert.equal(profile.features.importsEnabled, false);
});

test('managed membership inherits existing mobile selection until explicitly overridden', () => {
  const inherited = { ...server, hiddifyAndroidEnabled: undefined, mobileEnabled: true };
  assert.equal(isHiddifyAndroidServerSupported(inherited), true);
  assert.equal(isHiddifyAndroidServerSupported({ ...server, hiddifyAndroidEnabled: false, mobileEnabled: true }), false);
  assert.equal(isHiddifyAndroidServerSupported({ ...server, hiddifyAndroidEnabled: true, mobileEnabled: false }), true);
});

test('country and masked transport are stable', () => {
  assert.equal(hiddifyAndroidCountryCode(server), 'DE');
  const transport = buildHiddifyAndroidTransport(
    server,
    uuid,
    '142.251.39.142',
    { connectionMode: 'masked' }
  );
  assert.equal(transport.address, '142.251.39.142');
  assert.equal(transport.host, 'node.example.com');
  assert.equal(transport.security, 'tls');
});

test('manual refresh nonce changes only the revision', () => {
  const first = buildHiddifyAndroidProfileFromData(
    [server],
    { connectionMode: 'direct', hiddifyAndroidProfileRevisionNonce: 'one' },
    1,
    uuid
  );
  const second = buildHiddifyAndroidProfileFromData(
    [server],
    { connectionMode: 'direct', hiddifyAndroidProfileRevisionNonce: 'two' },
    1,
    uuid
  );
  assert.notEqual(first.revision, second.revision);
  assert.deepEqual(first.servers, second.servers);
});
