import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCdnAddressOverrides,
  buildCdnServicesSummary,
  classifyCdnServer,
  normalizeOptionalCdnHostname,
  normalizeOptionalCdnIp,
  normalizeOptionalCdnPort,
  summarizeCdnAddressOverrides,
} from '../lib/cdn-address-ips.js';

const servers = [
  { id: 'fr-bn', host: 'fr.b-cdn.net', addressIp: '138.199.36.9', enabled: true },
  { id: 'de-cf', host: 'de.levospeed.click', region: 'cloudflare-finalmask', addressIp: '8.6.112.0', enabled: true },
  { id: 'te-fr1', idName: 'te', host: 'daykoo-tencent-fr1.levospeed.click', name: 'Tencent FR1', addressIp: '43.174.196.65', enabled: true },
  { id: 'ali-a1', host: 'cdn-a1.levospeed.click', name: 'Alibaba FR1', addressIp: '163.181.0.187', enabled: true },
  { id: 'relay', host: 'relay.example.com', addressIp: '1.2.3.4', enabled: true },
];

test('classifies Bunny, Cloudflare, Tencent, Alibaba without touching relay', () => {
  assert.equal(classifyCdnServer(servers[0]), 'bunny');
  assert.equal(classifyCdnServer(servers[1]), 'cloudflare');
  assert.equal(classifyCdnServer(servers[2]), 'tencent');
  assert.equal(classifyCdnServer(servers[3]), 'alibaba');
  assert.equal(classifyCdnServer(servers[4]), '');
});

test('cdn-a* hosts are Alibaba even on levospeed.click', () => {
  assert.equal(classifyCdnServer({ host: 'cdn-a3.levospeed.click' }), 'alibaba');
  assert.equal(classifyCdnServer({ id: 'tencent-edgeone-fr1-daykoo', host: 'daykoo-tencent-fr1.levospeed.click' }), 'tencent');
});

test('applies and clears provider overrides independently', () => {
  const applied = applyCdnAddressOverrides(
    { relay: '9.9.9.9', 'de-cf': '8.8.8.8' },
    servers,
    { bunny: '5.189.202.62', cloudflare: '' }
  );
  assert.deepEqual(applied.serverAddressIps, {
    relay: '9.9.9.9',
    'fr-bn': '5.189.202.62',
  });
  assert.deepEqual(applied.changedServerIds, ['fr-bn', 'de-cf']);
});

test('summarizes custom and effective provider IPs', () => {
  const summary = summarizeCdnAddressOverrides(
    { serverAddressIps: { 'fr-bn': '5.189.202.62', 'te-fr1': '1.1.1.1' } },
    servers
  );
  assert.equal(summary.bunny.customIp, '5.189.202.62');
  assert.deepEqual(summary.bunny.effectiveIps, ['5.189.202.62']);
  assert.equal(summary.cloudflare.customIp, '');
  assert.deepEqual(summary.cloudflare.effectiveIps, ['8.6.112.0']);
  assert.equal(summary.tencent.customIp, '1.1.1.1');
  assert.equal(summary.alibaba.customIp, '');
  assert.deepEqual(summary.alibaba.effectiveIps, ['163.181.0.187']);
});

test('builds CDN services summary for panel buttons', () => {
  const services = buildCdnServicesSummary(servers);
  const byId = Object.fromEntries(services.map((row) => [row.id, row]));
  assert.equal(byId.tencent.serverCount, 1);
  assert.equal(byId.tencent.sharedIp, '43.174.196.65');
  assert.equal(byId.alibaba.serverCount, 1);
  assert.equal(byId.alibaba.sharedIp, '163.181.0.187');
  assert.equal(byId.bunny.serverCount, 1);
  assert.equal(byId.bunny.servers[0].port, 443);
  assert.equal(byId.cloudflare.serverCount, 1);
  assert.ok(!byId.relay);
});

test('accepts empty value for fallback and rejects invalid IPv4', () => {
  assert.equal(normalizeOptionalCdnIp(''), '');
  assert.equal(normalizeOptionalCdnIp(' 138.199.36.9 '), '138.199.36.9');
  assert.throws(() => normalizeOptionalCdnIp('not-an-ip'), /valid IPv4/);
});

test('validates CDN subscription ports', () => {
  assert.equal(normalizeOptionalCdnPort(' 443 '), 443);
  assert.equal(normalizeOptionalCdnPort(''), '');
  assert.throws(() => normalizeOptionalCdnPort('0'), /between 1 and 65535/);
  assert.throws(() => normalizeOptionalCdnPort('65536'), /between 1 and 65535/);
  assert.throws(() => normalizeOptionalCdnPort('443.5'), /between 1 and 65535/);
});

test('validates SNI/HOST as a DNS hostname', () => {
  assert.equal(normalizeOptionalCdnHostname(' FR1.SHELBY-FAST.SITE. '), 'fr1.shelby-fast.site');
  assert.equal(normalizeOptionalCdnHostname(''), '');
  assert.throws(() => normalizeOptionalCdnHostname('https://example.com/path'), /valid DNS hostname/);
  assert.throws(() => normalizeOptionalCdnHostname('216.24.57.1'), /valid DNS hostname/);
});

test('summarizes shared SNI and HOST values', () => {
  const [cloudflare] = buildCdnServicesSummary([
    { id: 'cf-1', name: 'CF FR1', host: 'fr1.shelby-fast.site', sni: 'fr1.shelby-fast.site', enabled: true },
  ]).filter((row) => row.id === 'cloudflare');
  assert.equal(cloudflare.sharedHost, 'fr1.shelby-fast.site');
  assert.equal(cloudflare.sharedSni, 'fr1.shelby-fast.site');
});
