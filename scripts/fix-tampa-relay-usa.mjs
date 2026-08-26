#!/usr/bin/env node
/**
 * Fix tampa-relay timeouts + rename glb-vps-1 to USA in panel.
 * - Redeploy relay env (WS ping, upstream) on existing image
 * - 1 CPU / 1 Gi / min 1 / max 2
 * - Sync Tampa VPS Xray clients
 * - Update server name/country + refresh relay users subs (optional)
 *
 *   docker exec vpn-panel-api-vps node /app/scripts/fix-tampa-relay-usa.mjs
 */
import { deployVpnWsRelay } from '../lib/cloud-run-relay-deploy.js';
import { nowIso } from '../lib/dates.js';
import { getServerById, listUsers, upsertServer } from '../lib/db-store.js';
import { syncRelayVpsEdges } from '../lib/relay-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';

const PROFILE_ID = 'gcp-soppy';
const RELAY_SERVICE = 'tampa-relay';
const RELAY_REGION = 'us-central1';
const SERVER_ID = 'glb-vps-1';
const UPSTREAM_WS_URL = 'ws://74.115.172.101:8080/';
const RELAY_IMAGE =
  process.env.RELAY_IMAGE ||
  'europe-west4-docker.pkg.dev/project-053f672c-ae3c-4479-865/vpn-panel/vpn-ws-relay:latest';

const skipGcp = process.env.SKIP_GCP === '1';

const cpu = 1;
const memory = '1Gi';
const minInstances = 1;
const maxInstances = 2;

let host = String(process.env.RELAY_HOST || '').trim();
let relayUrl = host ? `https://${host}` : '';

if (!skipGcp) {
  console.log(JSON.stringify({ step: 'redeployTampaRelay', image: RELAY_IMAGE }));
  const deploy = await deployVpnWsRelay(PROFILE_ID, {
    serviceName: RELAY_SERVICE,
    region: RELAY_REGION,
    upstreamWsUrl: UPSTREAM_WS_URL,
    cpu,
    memory,
    minInstances,
    maxInstances,
    cpuThrottling: false,
    timeoutSeconds: 3600,
    skipBuild: true,
    image: RELAY_IMAGE,
  });
  host = deploy.host || host;
  relayUrl = deploy.url || relayUrl;
}

if (!host) {
  host = 'tampa-relay-phmuswjaga-uc.a.run.app';
}

const serverBefore = await getServerById(SERVER_ID);
await upsertServer(SERVER_ID, {
  ...(serverBefore || { id: SERVER_ID }),
  id: SERVER_ID,
  enabled: true,
  name: 'USA',
  country: 'USA',
  flag: '🇺🇸',
  host,
  service: RELAY_SERVICE,
  cloudRunService: RELAY_SERVICE,
  region: RELAY_REGION,
  cloudRunRegion: RELAY_REGION,
  addressIp: '',
  port: 443,
  protocol: 'vless',
  network: 'ws',
  path: '/',
  security: 'tls',
  sni: 'www.google.com',
  fingerprint: 'chrome',
  alpn: 'http/1.1',
  cpu,
  memory,
  minInstances,
  maxInstances,
  timeoutSeconds: 3600,
  cloudRunProfileId: PROFILE_ID,
  relayPilot: true,
  externalVps: true,
  relayUpstream: UPSTREAM_WS_URL,
  sortOrder: serverBefore?.sortOrder ?? 70,
  newUsersOnly: serverBefore?.newUsersOnly ?? true,
  updatedAt: nowIso(),
  createdAt: serverBefore?.createdAt || nowIso(),
});

console.log(JSON.stringify({ step: 'syncTampaEdge' }));
const edgeSync = await syncRelayVpsEdges({ force: true });

let subsRefreshed = 0;
if (process.env.REFRESH_SUBSCRIPTIONS !== '0') {
  for (const user of await listUsers()) {
    if (user.enabled === false) continue;
    const bonus = (user.bonusServerIds || []).map(String);
    if (!bonus.includes(SERVER_ID) && user.relayOnly !== true) continue;
    await upsertUserSubscriptionFile(user);
    subsRefreshed += 1;
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      relay: { host, url: relayUrl, upstream: UPSTREAM_WS_URL },
      server: { id: SERVER_ID, name: 'USA', country: 'USA', flag: '🇺🇸' },
      edgeSync,
      subsRefreshed,
    },
    null,
    2
  )
);
