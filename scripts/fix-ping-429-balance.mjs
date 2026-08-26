#!/usr/bin/env node
/**
 * Fix Happ ping 429: rebalance warm CPUs per region, redeploy failing relays.
 *
 *   docker exec vpn-panel-api-vps node /app/scripts/fix-ping-429-balance.mjs
 */
import { deployVpnWsRelay } from '../lib/cloud-run-relay-deploy.js';
import { getServerById, listUsers, upsertServer } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { probeMaskedTls } from '../lib/masked-tls-probe.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { RELAY_EDGE_DEFAULTS } from './eu-relay-dayanch/config.mjs';
import { nowIso } from '../lib/dates.js';

const PROFILE_ID = 'gcp-75063f06';
const IMAGE =
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest';

/** Max warm (min=1) instances per GCP region to avoid CPU 429. */
const REGION_WARM_CAP = {
  'europe-west4': 2,
  'europe-west1': 3,
  'us-central1': 1,
};

const TARGETS = [
  { id: 'gcp2-eu-nl', service: 'gcp2-relay-eu-nl', region: 'europe-west4', upstream: 'ws://194.127.178.70:8081/', warmPriority: 1 },
  { id: 'gcp2-eu-am', service: 'gcp2-relay-eu-am', region: 'europe-west4', upstream: 'ws://194.127.179.178:8083/', warmPriority: 2 },
  { id: 'gcp2-eu-de', service: 'gcp2-relay-eu-de', region: 'europe-west1', upstream: 'ws://2.26.231.130:8082/', warmPriority: 1 },
  { id: 'gcp2-eu-gb', service: 'gcp2-relay-eu-gb', region: 'europe-west1', upstream: 'ws://185.169.234.182:8084/', warmPriority: 2 },
  { id: 'gcp2-eu-de2', service: 'gcp2-relay-eu-de2', region: 'europe-west1', upstream: 'ws://45.133.251.146:8085/', warmPriority: 3 },
  { id: 'gcp2-eu-fr1', service: 'gcp2-relay-eu-fr1', region: 'europe-west1', upstream: 'ws://185.209.230.14:8088/', warmPriority: 4 },
  { id: 'gcp2-eu-fr2', service: 'gcp2-relay-eu-fr2', region: 'europe-west1', upstream: 'ws://185.209.230.46:8089/', warmPriority: 5 },
  { id: 'gcp2-usa', service: 'gcp2-tampa-relay', region: 'us-central1', upstream: 'ws://74.115.172.101:8080/', warmPriority: 1 },
];

process.env.RELAY_WS_PING_MS = String(RELAY_EDGE_DEFAULTS.wsPingMs || 25000);

await updatePanelSettings({
  subscriptionWarmOnly: false,
  subscriptionMinServers: 8,
});

const byRegion = new Map();
for (const t of TARGETS.sort((a, b) => a.warmPriority - b.warmPriority)) {
  if (!byRegion.has(t.region)) byRegion.set(t.region, []);
  byRegion.get(t.region).push(t);
}

const plan = [];
for (const [region, items] of byRegion) {
  const cap = REGION_WARM_CAP[region] ?? 2;
  items.forEach((item, i) => {
    plan.push({
      ...item,
      minInstances: i < cap ? 1 : 0,
      maxInstances: 2,
    });
  });
}

const results = [];
for (const item of plan) {
  const deploy = await deployVpnWsRelay(PROFILE_ID, {
    serviceName: item.service,
    region: item.region,
    upstreamWsUrl: item.upstream,
    cpu: RELAY_EDGE_DEFAULTS.cpu,
    memory: RELAY_EDGE_DEFAULTS.memory,
    minInstances: item.minInstances,
    maxInstances: item.maxInstances,
    cpuThrottling: false,
    sessionAffinity: true,
    maxInstanceRequestConcurrency: item.id === 'gcp2-usa' ? 16 : RELAY_EDGE_DEFAULTS.maxInstanceRequestConcurrency,
    timeoutSeconds: RELAY_EDGE_DEFAULTS.timeoutSeconds,
    skipBuild: true,
    image: IMAGE,
  });

  const panel = await getServerById(item.id);
  if (panel) {
    await upsertServer(item.id, {
      ...panel,
      enabled: true,
      host: deploy.host,
      service: item.service,
      cloudRunService: item.service,
      region: item.region,
      cloudRunRegion: item.region,
      minInstances: item.minInstances,
      maxInstances: item.maxInstances,
      cpuThrottling: false,
      sessionAffinity: true,
      updatedAt: nowIso(),
    });
  }

  results.push({
    id: item.id,
    region: item.region,
    min: item.minInstances,
    max: item.maxInstances,
    host: deploy.host,
  });
}

let subs = 0;
for (const user of await listUsers(10000)) {
  await upsertUserSubscriptionFile(user);
  subs += 1;
}

const panel = await getPanelSettings();
const maskedIp = String(panel.addressIps?.[0] || '216.58.198.50').trim();
await new Promise((r) => setTimeout(r, 8000));

const probes = [];
for (const item of TARGETS) {
  const s = await getServerById(item.id);
  const p = await probeMaskedTls(s, maskedIp, 20000);
  probes.push({ id: item.id, ok: p.ok, status: p.status, ms: p.ms, error: p.error });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      note: 'Warm capped per region to avoid GCP 429; cold lines scale on connect (max=2)',
      regionCaps: REGION_WARM_CAP,
      deployed: results,
      subscriptionsRefreshed: subs,
      pingOk: probes.filter((p) => p.ok).map((p) => p.id),
      pingFail: probes.filter((p) => !p.ok),
    },
    null,
    2
  )
);
