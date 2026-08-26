#!/usr/bin/env node
import { mkdir, writeFile } from 'fs/promises';
import { deployVpnWsRelay } from '../lib/cloud-run-relay-deploy.js';
import { getServerById, listUsers, upsertServer } from '../lib/db-store.js';
import { getPanelSettings } from '../lib/settings.js';
import { normalizeAddressIps } from '../lib/address-ips.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { probeMaskedTls } from '../lib/masked-tls-probe.js';
import { nowIso } from '../lib/dates.js';

const PROFILE_ID = 'gcp-75063f06';
const IMAGE =
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest';
const FORNEX_UPSTREAM = 'ws://130.17.12.61:18080/assets/v3/sync';
const FORNEX_SERVICE = 'gcp2-fornex-relay';
const FORNEX_REGION = 'europe-west1';

const [panel, tampaPilot, fornexPilot, tampaRelay] = await Promise.all([
  getPanelSettings(),
  getServerById('pilot-tampa-reality'),
  getServerById('pilot-fornex-reality'),
  getServerById('gcp2-usa'),
]);
if (!tampaPilot || !fornexPilot || !tampaRelay?.host) {
  throw new Error('Required Tampa/Fornex server records are missing');
}

const backupDir = '/data/files/backups';
await mkdir(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${backupDir}/tampa-fornex-relay-fix-${stamp}.json`;
await writeFile(
  backupPath,
  JSON.stringify({ createdAt: nowIso(), tampaPilot, fornexPilot, tampaRelay }, null, 2),
  'utf8'
);

const deploy = await deployVpnWsRelay(PROFILE_ID, {
  serviceName: FORNEX_SERVICE,
  region: FORNEX_REGION,
  upstreamWsUrl: FORNEX_UPSTREAM,
  minInstances: 1,
  maxInstances: 2,
  maxInstanceRequestConcurrency: 16,
  timeoutSeconds: 3600,
  cpu: 1,
  memory: '1Gi',
  cpuThrottling: false,
  sessionAffinity: true,
  skipBuild: true,
  image: IMAGE,
});

const addressIp =
  normalizeAddressIps(panel.addressIps)[0] ||
  normalizeAddressIps(tampaRelay.addressIp || tampaRelay.addressIps)[0] ||
  '216.58.198.50';
const timestamp = nowIso();
const relayFields = {
  addressIp,
  port: 443,
  protocol: 'vless',
  network: 'ws',
  path: '/api/v1/socket',
  security: 'tls',
  sni: 'www.google.com',
  fingerprint: 'chrome',
  alpn: 'http/1.1',
  flow: '',
  realityPublicKey: null,
  realityShortId: null,
  spiderX: null,
  externalVps: false,
  standalonePilot: false,
  relayPilot: true,
  enabled: true,
  updatedAt: timestamp,
};

await upsertServer('pilot-tampa-reality', {
  ...tampaPilot,
  ...relayFields,
  host: tampaRelay.host,
  service: tampaRelay.service || 'gcp2-tampa-relay',
  cloudRunService: tampaRelay.cloudRunService || 'gcp2-tampa-relay',
  region: tampaRelay.region || 'us-central1',
  cloudRunRegion: tampaRelay.cloudRunRegion || tampaRelay.region || 'us-central1',
  cloudRunProfileId: tampaRelay.cloudRunProfileId || PROFILE_ID,
  relayUpstream: 'ws://74.115.172.101:8080/',
  minInstances: Number(tampaRelay.minInstances ?? 1),
  maxInstances: Number(tampaRelay.maxInstances ?? 2),
});

await upsertServer('pilot-fornex-reality', {
  ...fornexPilot,
  ...relayFields,
  host: deploy.host,
  service: FORNEX_SERVICE,
  cloudRunService: FORNEX_SERVICE,
  region: FORNEX_REGION,
  cloudRunRegion: FORNEX_REGION,
  cloudRunProfileId: PROFILE_ID,
  relayUpstream: FORNEX_UPSTREAM,
  minInstances: 1,
  maxInstances: 2,
  maxInstanceRequestConcurrency: 16,
  timeoutSeconds: 3600,
  cpu: 1,
  memory: '1Gi',
});

let refreshed = 0;
const failures = [];
for (const user of await listUsers(10000)) {
  await upsertUserSubscriptionFile(user);
  refreshed += 1;
  if (user.enabled === false || !user.uuid) continue;
  const body = await buildUserSubscriptionBody(user);
  if (body.includes('@74.115.172.101:9443') || body.includes('@130.17.12.61:443')) {
    failures.push(user.id);
  }
}
if (failures.length) {
  throw new Error(`Direct Tampa/Fornex endpoints remain in subscriptions: ${failures.join(',')}`);
}

await new Promise((resolve) => setTimeout(resolve, 15000));
const [tampaProbe, fornexProbe] = await Promise.all([
  probeMaskedTls(await getServerById('pilot-tampa-reality'), addressIp, 30000),
  probeMaskedTls(await getServerById('pilot-fornex-reality'), addressIp, 30000),
]);
if (!tampaProbe.ok || !fornexProbe.ok) {
  throw new Error(
    `Relay probe failed: Tampa=${tampaProbe.status || tampaProbe.error}, Fornex=${fornexProbe.status || fornexProbe.error}`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      backupPath,
      refreshed,
      addressIp,
      tampa: { host: tampaRelay.host, probeMs: tampaProbe.ms },
      fornex: { host: deploy.host, upstream: FORNEX_UPSTREAM, probeMs: fornexProbe.ms },
      directEndpointsRemaining: 0,
    },
    null,
    2
  )
);
