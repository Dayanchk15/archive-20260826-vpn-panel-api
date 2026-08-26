import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMobileProfileFromData,
  buildPublicMobileProfileFromData,
  buildMobileTransport,
  countryCodeForServer,
  isMobileServerSupported,
} from '../lib/mobile-profile.js';

const activeUser = {
  id: 'usr_test',
  uuid: '11111111-1111-4111-8111-111111111111',
  status: 'active',
  expiresAt: '2099-01-01T00:00:00.000Z',
  trafficLimitGB: 50,
  uploadUsedGB: 1.25,
  downloadUsedGB: 2.75,
  serverIds: ['de'],
};

const mobileServer = {
  id: 'de',
  name: 'Germany',
  country: 'Germany',
  flag: '🇩🇪',
  host: 'relay-de.example.run.app',
  addressIp: '142.251.39.142',
  port: 443,
  protocol: 'vless',
  network: 'ws',
  security: 'tls',
  path: '/',
  sni: 'www.google.com',
  enabled: true,
  mobileEnabled: true,
  sortOrder: 10,
};

test('mobile transport preserves masked WS+TLS routing without exposing panel credentials', () => {
  const transport = buildMobileTransport(activeUser, mobileServer, mobileServer.addressIp, {
    connectionMode: 'masked',
  }, 7);
  assert.equal(transport.address, '142.251.39.142');
  assert.equal(transport.host, 'relay-de.example.run.app');
  assert.equal(transport.sni, 'www.google.com');
  assert.equal(transport.network, 'ws');
  assert.equal(transport.security, 'tls');
  assert.equal(transport.uuid, activeUser.uuid);
  assert.equal('adminApiKey' in transport, false);
});

test('mobile Xray fragmentation is independent from Happ and includes maxSplit', () => {
  const transport = buildMobileTransport(activeUser, mobileServer, mobileServer.addressIp, {
    connectionMode: 'masked',
    happFragmentationEnabled: false,
    mobileFragmentationEnabled: true,
    mobileFragmentationPackets: 'tlshello',
    mobileFragmentationLength: '2',
    mobileFragmentationInterval: '0-1',
    mobileFragmentationMaxSplit: '3-6',
  }, 7);
  assert.equal(transport.fragmentationEnabled, true);
  assert.deepEqual(transport.fragmentation, {
    enabled: true,
    packets: 'tlshello',
    length: '2',
    interval: '0-1',
    maxSplit: '3-6',
  });
  const disabled = buildMobileTransport(activeUser, mobileServer, mobileServer.addressIp, {
    mobileFragmentationEnabled: false,
    happFragmentationEnabled: true,
  }, 7);
  assert.equal(disabled.fragmentationEnabled, false);
  assert.equal(disabled.fragmentation, null);
  const legacy = buildMobileTransport(activeUser, mobileServer, mobileServer.addressIp, {
    mobileFragmentationEnabled: true,
  }, 6);
  assert.equal(legacy.fragmentationEnabled, false);
  assert.equal(legacy.fragmentation, null);
});

test('profile only includes explicitly enabled supported mobile servers', () => {
  const unsupported = { ...mobileServer, id: 'reality', network: 'tcp', security: 'reality' };
  const hidden = { ...mobileServer, id: 'hidden', mobileEnabled: false };
  const user = { ...activeUser, serverIds: ['de', 'reality', 'hidden'] };
  const profile = buildMobileProfileFromData(user, [mobileServer, unsupported, hidden], {
    connectionMode: 'masked',
    subscriptionWarmOnly: false,
    subscriptionMinServers: 3,
  });
  assert.equal(profile.user.status, 'active');
  assert.equal(profile.user.traffic.totalGB, 4);
  assert.deepEqual(profile.locations.map((location) => location.id), ['de']);
  assert.equal(profile.locations[0].countryCode, 'DE');
});

test('disabled accounts receive account state but no VPN locations', () => {
  const profile = buildMobileProfileFromData(
    { ...activeUser, status: 'disabled', disabledReason: 'manual' },
    [mobileServer],
    { connectionMode: 'masked', subscriptionWarmOnly: false }
  );
  assert.equal(profile.user.status, 'disabled');
  assert.equal(profile.user.reason, 'manual');
  assert.deepEqual(profile.locations, []);
});

test('server support gate is explicit and country mapping is stable', () => {
  assert.equal(isMobileServerSupported(mobileServer, 1), true);
  assert.equal(isMobileServerSupported({ ...mobileServer, mobileMinVersion: 2 }, 1), false);
  assert.equal(countryCodeForServer(mobileServer), 'DE');
});

test('public profile requires no client and uses only panel-enabled mobile servers', () => {
  const hidden = { ...mobileServer, id: 'hidden', mobileEnabled: false };
  const france = { ...mobileServer, id: 'fr', country: 'France', sortOrder: 20, mobilePriority: 20 };
  const netherlands = { ...mobileServer, id: 'nl', country: 'Netherlands', sortOrder: 30, mobilePriority: 30 };
  const publicUuid = '22222222-2222-4222-8222-222222222222';
  const profile = buildPublicMobileProfileFromData(
    [mobileServer, france, netherlands, hidden],
    { connectionMode: 'masked', subscriptionWarmOnly: false, subscriptionMinServers: 1 },
    1,
    publicUuid
  );
  assert.equal(profile.accessMode, 'public');
  assert.equal(profile.user.status, 'active');
  assert.equal(profile.user.expiresAt, null);
  assert.deepEqual(profile.locations.map((location) => location.id), ['de', 'fr', 'nl']);
  assert.equal(profile.locations[0].transport.uuid, publicUuid);
});

test('manual mobile refresh nonce changes profile revision without changing locations', () => {
  const panel = {
    connectionMode: 'masked',
    subscriptionWarmOnly: false,
    subscriptionMinServers: 1,
  };
  const first = buildPublicMobileProfileFromData(
    [mobileServer],
    { ...panel, mobileProfileRevisionNonce: 'refresh-1' },
    1,
    '22222222-2222-4222-8222-222222222222'
  );
  const second = buildPublicMobileProfileFromData(
    [mobileServer],
    { ...panel, mobileProfileRevisionNonce: 'refresh-2' },
    1,
    '22222222-2222-4222-8222-222222222222'
  );

  assert.notEqual(first.revision, second.revision);
  assert.deepEqual(first.locations, second.locations);
  assert.equal('refreshNonce' in first, false);
});
