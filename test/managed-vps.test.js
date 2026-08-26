import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildManagedXrayConfig } from '../lib/managed-xray.js';
import { outlineCertificatePinMatches, toHappShadowsocksUrl } from '../lib/outline-management.js';

test('managed Xray VLESS TCP template is constrained and emits one client', () => {
  const { normalized, config } = buildManagedXrayConfig({
    template: 'vless-tcp',
    port: 8443,
    uuid: '11111111-1111-4111-8111-111111111111',
    name: 'test',
    outbound: { protocol: 'freedom' },
  });
  assert.equal(normalized.template, 'vless-tcp');
  assert.equal(config.inbounds[0].settings.clients.length, 1);
  assert.equal(config.inbounds[0].port, 8443);
  assert.equal(config.outbounds[0].protocol, 'freedom');
});

test('managed Xray can accept UUIDs for all selected clients from the main DB', () => {
  const { normalized, config } = buildManagedXrayConfig({
    template: 'vless-ws-tls',
    port: 9443,
    clientUuids: [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ],
    name: 'all clients',
    host: 'edge.example.com',
    sni: 'edge.example.com',
    outbound: { protocol: 'freedom' },
  });
  assert.deepEqual(normalized.clientUuids, [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]);
  assert.deepEqual(config.inbounds[0].settings.clients.map((client) => client.id), normalized.clientUuids);
});

test('managed Xray rejects unsupported templates and unsafe values', () => {
  assert.throws(() => buildManagedXrayConfig({ template: 'arbitrary-json', port: 443 }));
  assert.throws(() => buildManagedXrayConfig({ template: 'vless-tcp', port: 70000 }));
  assert.throws(() => buildManagedXrayConfig({ template: 'vless-ws-tls', port: 443, path: '/ok\nunsafe' }));
});

test('managed Xray VLESS outbound requires a single valid UUID', () => {
  assert.throws(() => buildManagedXrayConfig({
    template: 'vless-tcp',
    port: 443,
    outbound: { protocol: 'vless', address: '198.51.100.2', port: 443, uuid: 'bad' },
  }));
});

test('Outline certificate pins accept hex, base64 and base64url encodings', () => {
  const cert = Buffer.from('test-certificate');
  const digest = createHash('sha256').update(cert).digest();
  assert.equal(outlineCertificatePinMatches(digest.toString('hex'), cert), true);
  assert.equal(outlineCertificatePinMatches(`SHA256:${digest.toString('base64')}`, cert), true);
  assert.equal(outlineCertificatePinMatches(`sha256/${digest.toString('base64url')}`, cert), true);
  assert.equal(outlineCertificatePinMatches('not-the-certificate', cert), false);
});

test('Outline keys expose a Happ-compatible SIP002 URL', () => {
  const outline = 'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNToE0Q3cU90N1Y4OU83YWM4UGNDQ1dh@193.233.219.208:53998/?outline=1';
  assert.equal(
    toHappShadowsocksUrl(outline, 'Russia Moscow'),
    'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNToE0Q3cU90N1Y4OU83YWM4UGNDQ1dh@193.233.219.208:53998#Russia%20Moscow',
  );
});
