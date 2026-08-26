#!/usr/bin/env node
/**
 * Optimize gcp-soppy prod relays for TM: warm NL/DE/AM min=1, 2CPU/2Gi, no CPU throttling.
 * Does NOT touch gcp2 pool or refresh user subscriptions.
 *
 *   docker exec vpn-panel-api-vps node /app/scripts/optimize-prod-relays-tm.mjs
 *   SKIP_TAMPA=1 node scripts/optimize-prod-relays-tm.mjs
 */
import { deployVpnWsRelay } from '../lib/cloud-run-relay-deploy.js';
import { getPanelSettings } from '../lib/settings.js';
import { getServerById, upsertServer } from '../lib/db-store.js';
import { normalizeAddressIps } from '../lib/address-ips.js';
import { nowIso } from '../lib/dates.js';
import {
  PROFILE_ID,
  RELAY_EDGE_DEFAULTS,
  activeEuEdges,
  edgeRelayRegion,
  edgeRelayServiceName,
  edgeUpstreamWsUrl,
} from './eu-relay-dayanch/config.mjs';

const IMAGE =
  process.env.RELAY_IMAGE ||
  'europe-west4-docker.pkg.dev/project-053f672c-ae3c-4479-865/vpn-panel/vpn-ws-relay:latest';
const PAUSE_MS = Number(process.env.RELAY_GO_PAUSE_MS || 20000);
const CONCURRENCY = Number(process.env.RELAY_WS_CONCURRENCY || 250);
const WARM_EDGE_IDS = String(process.env.WARM_EDGE_IDS || 'relay-eu-nl,relay-eu-de,relay-eu-am')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SKIP_TAMPA = process.env.SKIP_TAMPA === '1';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const panel = await getPanelSettings();
const addressIp = normalizeAddressIps(panel.addressIps)[0] || '172.217.16.142';

const queue = activeEuEdges()
  .filter((edge) => WARM_EDGE_IDS.includes(edge.id))
  .map((edge) => ({
    edgeId: edge.id,
    panelId: edge.id,
    serviceName: edgeRelayServiceName(edge),
    region: edgeRelayRegion(edge),
    upstreamWsUrl: edgeUpstreamWsUrl(edge),
    cpu: 2,
    memory: '2Gi',
    minInstances: 1,
    maxInstances: 2,
  }));

if (!SKIP_TAMPA) {
  queue.push({
    edgeId: 'glb-vps-1',
    panelId: 'glb-vps-1',
    serviceName: 'tampa-relay',
    region: 'us-central1',
    upstreamWsUrl: 'ws://74.115.172.101:8080/',
    cpu: 2,
    memory: '2Gi',
    minInstances: 1,
    maxInstances: 2,
  });
}

if (!queue.length) throw new Error('No relay edges matched WARM_EDGE_IDS');

const results = [];
for (const item of queue) {
  console.log(JSON.stringify({ step: 'optimize', profileId: PROFILE_ID, ...item }));
  const deploy = await deployVpnWsRelay(PROFILE_ID, {
    serviceName: item.serviceName,
    region: item.region,
    upstreamWsUrl: item.upstreamWsUrl,
    cpu: item.cpu,
    memory: item.memory,
    minInstances: item.minInstances,
    maxInstances: item.maxInstances,
    maxInstanceRequestConcurrency: CONCURRENCY,
    cpuThrottling: false,
    sessionAffinity: true,
    timeoutSeconds: RELAY_EDGE_DEFAULTS.timeoutSeconds,
    skipBuild: true,
    image: IMAGE,
  });

  const existing = await getServerById(item.panelId);
  if (existing) {
    await upsertServer(item.panelId, {
      ...existing,
      host: deploy.host,
      addressIp,
      cpu: item.cpu,
      memory: item.memory,
      minInstances: item.minInstances,
      maxInstances: item.maxInstances,
      maxInstanceRequestConcurrency: CONCURRENCY,
      cpuThrottling: false,
      sessionAffinity: true,
      updatedAt: nowIso(),
    });
  }

  results.push({
    panelId: item.panelId,
    service: item.serviceName,
    region: item.region,
    host: deploy.host,
    cpu: item.cpu,
    memory: item.memory,
    minInstances: item.minInstances,
    cpuThrottling: false,
  });
  console.log(JSON.stringify({ step: 'done', host: deploy.host }, null, 2));
  await sleep(PAUSE_MS);
}

console.log(JSON.stringify({ ok: true, profileId: PROFILE_ID, addressIp, warmEdges: WARM_EDGE_IDS, results }, null, 2));
