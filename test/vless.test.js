import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVlessLink, formatServerRemark } from '../lib/vless.js';

test('subscription remarks preserve CDN labels and mark relay nodes', () => {
  assert.equal(
    formatServerRemark({ flag: '🇫🇷', country: 'France', host: 'fr.b-cdn.net' }),
    '🇫🇷 France BN'
  );
  assert.equal(
    formatServerRemark({ flag: '🇩🇪', country: 'Germany', region: 'cloudflare-finalmask' }),
    '🇩🇪 Germany CF'
  );
  assert.equal(
    formatServerRemark({ flag: '🇳🇱', country: 'Netherlands', id: 'relay-eu-nl', host: 'relay.example.test' }),
    '🇳🇱 Netherlands [No Block]'
  );
});

test('subscription remarks mark Alibaba ESA lines', () => {
  assert.equal(
    formatServerRemark({ country: 'France', id: 'alibaba-esa-fr1-daykoo', host: 'cdn-a1.levospeed.click' }),
    'France FR1 ALI'
  );
});

import { stripFragmentationFromPlainBody } from '../lib/happ-fragmentation.js';

test('buildVlessLink includes xHTTP mode and Fastly routing fields', () => {
  const link = buildVlessLink(
    { uuid: '30bb7a59-6565-43e1-af83-3d54cf5d7466' },
    {
      id: 'pilot-fastly',
      host: 'edge.example.test',
      addressIp: '151.101.1.194',
      port: 443,
      network: 'xhttp',
      security: 'tls',
      path: '/tampa/',
      sni: 'edge.example.test',
      alpn: 'http/1.1',
      xhttpMode: 'packet-up',
    },
    { connectionMode: 'masked', connectAddressIp: '151.101.1.194' }
  );

  assert.match(link, /@151\.101\.1\.194:443\?/);
  assert.match(link, /type=xhttp/);
  assert.match(link, /path=%2Ftampa%2F/);
  assert.match(link, /host=edge\.example\.test/);
  assert.match(link, /sni=edge\.example\.test/);
  assert.match(link, /alpn=http%2F1\.1/);
  assert.match(link, /mode=packet-up/);
});

test('buildVlessLink serializes structured xHTTP extra settings', () => {
  const link = buildVlessLink(
    { uuid: 'b26aa89d-30d8-423d-95cb-99e5f9590eb5' },
    {
      host: 'mk1.global.ssl.fastly.net',
      addressIp: '151.101.71.122',
      port: 443,
      network: 'xhttp',
      security: 'tls',
      path: '/',
      sni: 'community.fastly.com',
      alpn: 'h3',
      fingerprint: 'firefox',
      xhttpMode: 'packet-up',
      xhttpExtra: { scMaxConcurrentPosts: 100 },
    },
    { connectionMode: 'masked' }
  );

  const parsed = new URL(link);
  assert.equal(parsed.searchParams.get('mode'), 'packet-up');
  assert.deepEqual(JSON.parse(parsed.searchParams.get('extra')), { scMaxConcurrentPosts: 100 });
});

test('buildVlessLink emits Cloudflare gRPC authority, h2 and UDP 443 policy', () => {
  const link = buildVlessLink(
    { uuid: 'cbb019d0-c345-4b37-b515-24fc68b73046' },
    {
      host: 'tampa.levospeed.click',
      addressIp: '8.6.112.0',
      port: 443,
      network: 'grpc',
      security: 'tls',
      grpcServiceName: 'tampa-sync',
      grpcAuthority: 'tampa.levospeed.click',
      sni: 'tampa.levospeed.click',
      alpn: 'h2',
      rejectUdp443: true,
    },
    { connectionMode: 'masked' }
  );

  assert.match(link, /@8\.6\.112\.0:443\?/);
  assert.match(link, /type=grpc/);
  assert.match(link, /serviceName=tampa-sync/);
  assert.match(link, /authority=tampa\.levospeed\.click/);
  assert.match(link, /alpn=h2/);
  assert.match(link, /xudpProxyUDP443=reject/);
});

test('buildVlessLink emits Happ double-encoded FinalMask for an isolated WS profile', () => {
  const finalMask = {
    tcp: [{
      type: 'fragment',
      settings: { delay: '1', length: '3', packets: 'tlshello', maxSplit: '5-10' },
    }],
  };
  const link = buildVlessLink(
    { uuid: 'cbb019d0-c345-4b37-b515-24fc68b73046' },
    {
      host: 'fr2.levospeed.click',
      addressIp: '8.6.112.0',
      port: 443,
      network: 'ws',
      security: 'tls',
      path: '/media/v3/fr2/ws',
      sni: 'fr2.levospeed.click',
      alpn: 'http/1.1',
      finalMask,
      rejectUdp443: false,
    },
    { connectionMode: 'masked', fragmentation: null }
  );

  const parsed = new URL(link);
  assert.match(link, /\?fm=/);
  const onceDecoded = parsed.searchParams.get('fm');
  assert.deepEqual(JSON.parse(decodeURIComponent(onceDecoded)), finalMask);
  assert.equal(parsed.searchParams.has('xudpProxyUDP443'), false);
  assert.equal(parsed.searchParams.has('fragment'), false);
  assert.equal(parsed.searchParams.has('encryption'), false);
  assert.equal(parsed.searchParams.has('headerType'), false);
  assert.equal(parsed.searchParams.get('allowInsecure'), '0');
});

test('buildVlessLink emits server-scoped legacy fragmentation when subscription fragmentation is disabled', () => {
  const link = buildVlessLink(
    { uuid: 'cbb019d0-c345-4b37-b515-24fc68b73046' },
    {
      host: 'levospeedfr1xhttp.b-cdn.net',
      addressIp: '94.20.154.22',
      port: 443,
      network: 'ws',
      security: 'tls',
      path: '/media/v3/fr1/ws?ed=2560',
      sni: 'levospeedfr1xhttp.b-cdn.net',
      fragmentation: {
        enabled: true,
        length: '2',
        interval: '0-1',
        packets: 'tlshello',
      },
    },
    { connectionMode: 'masked', fragmentation: null }
  );

  const parsed = new URL(link);
  assert.equal(parsed.searchParams.get('fragment'), '2,0-1,tlshello');
  assert.equal(parsed.searchParams.has('fm'), false);
  assert.equal(parsed.searchParams.get('host'), 'levospeedfr1xhttp.b-cdn.net');
});

test('buildVlessLink can preserve literal fragmentation commas for TM clients', () => {
  const link = buildVlessLink(
    { uuid: 'cbb019d0-c345-4b37-b515-24fc68b73046' },
    {
      host: 'fr1.levospeed.click',
      addressIp: '156.238.181.141',
      forceAddressIp: true,
      port: 443,
      network: 'ws',
      security: 'tls',
      path: '/',
      sni: 'fr1.levospeed.click',
      fragmentationEncoding: 'literal',
      compactWsShareLink: true,
      fragmentation: {
        enabled: true,
        length: '2',
        interval: '0-1',
        packets: 'tlshello',
      },
    },
    { connectionMode: 'masked' }
  );

  assert.match(link, /&fragment=2,0-1,tlshello#/);
  assert.doesNotMatch(link, /fragment=2%2C0-1%2Ctlshello/);
  assert.match(
    link,
    /\?type=ws&host=fr1\.levospeed\.click&path=\/&security=tls&sni=fr1\.levospeed\.click&alpn=http\/1\.1&fp=chrome&fragment=/
  );
  assert.doesNotMatch(link, /encryption=|headerType=/);
});

test('fragment cleanup preserves CDN server fragmentation and removes relay fragmentation', () => {
  const cdn = 'vless://cbb019d0-c345-4b37-b515-24fc68b73046@94.20.154.22:443?encryption=none&type=ws&host=levospeedfr1xhttp.b-cdn.net&fragment=2%2C0-1%2Ctlshello#CDN';
  const relay = 'vless://cbb019d0-c345-4b37-b515-24fc68b73046@216.58.198.50:443?encryption=none&type=ws&host=relay.example.run.app&fragment=2%2C0-1%2Ctlshello#Relay';
  const output = stripFragmentationFromPlainBody(`${cdn}\n${relay}\n`);
  const [cdnAfter, relayAfter] = output.trim().split('\n');
  assert.equal(new URL(cdnAfter).searchParams.get('fragment'), '2,0-1,tlshello');
  assert.equal(new URL(relayAfter).searchParams.has('fragment'), false);
});
