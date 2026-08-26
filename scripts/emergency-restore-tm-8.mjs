#!/usr/bin/env node
/**
 * Emergency: restore all 8 gcp2 relays to WS upstream + balanced warm caps.
 * FR1 only — no SS pilot. Does NOT change subscription node count.
 */
import { deployVpnWsRelay } from '/app/lib/cloud-run-relay-deploy.js';
import { getServerById, upsertServer } from '/app/lib/db-store.js';
import { probeMaskedTls } from '/app/lib/masked-tls-probe.js';
import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';

const PROFILE_ID = 'gcp-75063f06';
const IMAGE =
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest';
const DELAY_MS = Number(process.env.DEPLOY_DELAY_MS || 10000);

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

process.env.RELAY_WS_PING_MS = '25000';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

await updatePanelSettings({
  subscriptionWarmOnly: false,
  subscriptionMinServers: 8,
  subscriptionOnePerCountry: false,
  subscriptionTmShardEnabled: true,
});

const byRegion = new Map();
for (const t of [...TARGETS].sort((a, b) => a.warmPriority - b.warmPriority)) {
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
  console.log(JSON.stringify({ step: 'deploy', id: item.id, region: item.region, min: item.minInstances }));
  const deploy = await deployVpnWsRelay(PROFILE_ID, {
    serviceName: item.service,
    region: item.region,
    upstreamWsUrl: item.upstream,
    upstreamMode: 'ws',
    cpu: 1,
    memory: '1Gi',
    minInstances: item.minInstances,
    maxInstances: item.maxInstances,
    cpuThrottling: false,
    sessionAffinity: true,
    maxInstanceRequestConcurrency: item.id === 'gcp2-usa' ? 16 : 8,
    timeoutSeconds: 3600,
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
      relayUpstream: item.upstream,
      relayUpstreamMode: 'ws',
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
    host: deploy.host,
  });
  await sleep(DELAY_MS);
}

await sleep(60000);
const maskedIp = String((await getPanelSettings()).addressIps?.[0] || '216.58.198.50').trim();
const probes = [];
for (const item of TARGETS) {
  const s = await getServerById(item.id);
  const p = await probeMaskedTls(s, maskedIp, 20000);
  probes.push({ id: item.id, ok: p.ok, ms: p.ms, status: p.status, error: p.error });
}

console.log(
  JSON.stringify(
    {
      ok: probes.every((p) => p.ok),
      results,
      probes,
      pingOk: probes.filter((p) => p.ok).map((p) => p.id),
      pingFail: probes.filter((p) => !p.ok),
      note: 'All 8 restored to WS upstream; subscriptions unchanged',
    },
    null,
    2
  )
);

if (!probes.every((p) => p.ok)) process.exitCode = 1;
