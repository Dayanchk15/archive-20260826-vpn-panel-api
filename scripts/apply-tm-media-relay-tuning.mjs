#!/usr/bin/env node
/**
 * TM Media Mode: relay tuning (concurrency, session affinity, WS ping, max=2).
 *
 *   docker exec vpn-panel-api-vps node /app/scripts/apply-tm-media-relay-tuning.mjs
 *   DRY_RUN=1 — print plan only
 *
 * Env:
 *   RELAY_CONCURRENCY=8
 *   RELAY_MAX=2
 *   RELAY_WS_PING_MS=25000
 *   ACTIVE_EDGE_IDS=relay-eu-nl,relay-eu-de,relay-eu-am,relay-eu-de2,relay-eu-gb
 *   INCLUDE_TAMPA=1
 */
import { deployVpnWsRelay } from '../lib/cloud-run-relay-deploy.js';
import { getServerById } from '../lib/db-store.js';
import { nowIso } from '../lib/dates.js';
import {
  PROFILE_ID,
  RELAY_EDGE_DEFAULTS,
  activeEuEdges,
  edgeRelayRegion,
  edgeRelayServiceName,
  edgeUpstreamWsUrl,
} from './eu-relay-dayanch/config.mjs';

const DRY_RUN = ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN || '').toLowerCase());

process.env.RELAY_WS_PING_MS = String(process.env.RELAY_WS_PING_MS || RELAY_EDGE_DEFAULTS.wsPingMs || 25000);

const mediaEdgeIds = String(
  process.env.ACTIVE_EDGE_IDS || 'relay-eu-nl,relay-eu-de,relay-eu-am,relay-eu-de2,relay-eu-gb'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const edges = activeEuEdges().filter((e) => mediaEdgeIds.includes(e.id));
const concurrency = Number(process.env.RELAY_CONCURRENCY || RELAY_EDGE_DEFAULTS.maxInstanceRequestConcurrency || 8);
const maxInstances = Number(process.env.RELAY_MAX || RELAY_EDGE_DEFAULTS.maxInstances || 2);
const imageOverride = String(process.env.RELAY_IMAGE || '').trim();

const queue = edges.map((edge) => ({
  edgeId: edge.id,
  serviceName: edgeRelayServiceName(edge),
  region: edgeRelayRegion(edge),
  upstreamWsUrl: edgeUpstreamWsUrl(edge),
  maxInstances,
  concurrency,
}));

if (process.env.INCLUDE_TAMPA === '1') {
  queue.push({
    edgeId: 'glb-vps-1',
    serviceName: 'tampa-relay',
    region: 'us-central1',
    upstreamWsUrl: 'ws://74.115.172.101:8080/',
    maxInstances: Number(process.env.TAMPA_RELAY_MAX || 1),
    concurrency: Number(process.env.TAMPA_RELAY_CONCURRENCY || 16),
  });
}

if (!queue.length) {
  console.log(JSON.stringify({ ok: false, error: 'No relay targets in queue' }));
  process.exit(1);
}

const results = [];
for (const item of queue) {
  const plan = {
    ...item,
    cpu: RELAY_EDGE_DEFAULTS.cpu,
    memory: RELAY_EDGE_DEFAULTS.memory,
    minInstances: RELAY_EDGE_DEFAULTS.minInstances,
    sessionAffinity: true,
    cpuThrottling: false,
    wsPingMs: Number(process.env.RELAY_WS_PING_MS),
  };
  console.log(JSON.stringify({ step: DRY_RUN ? 'plan' : 'deploy', ...plan }));

  if (DRY_RUN) {
    results.push({ ...plan, dryRun: true });
    continue;
  }

  const deploy = await deployVpnWsRelay(PROFILE_ID, {
    serviceName: item.serviceName,
    region: item.region,
    upstreamWsUrl: item.upstreamWsUrl,
    cpu: RELAY_EDGE_DEFAULTS.cpu,
    memory: RELAY_EDGE_DEFAULTS.memory,
    minInstances: RELAY_EDGE_DEFAULTS.minInstances,
    maxInstances: item.maxInstances,
    cpuThrottling: false,
    sessionAffinity: true,
    maxInstanceRequestConcurrency: item.concurrency,
    timeoutSeconds: RELAY_EDGE_DEFAULTS.timeoutSeconds,
    skipBuild: Boolean(imageOverride),
    image: imageOverride || undefined,
  });

  const panelId = item.edgeId === 'glb-vps-1' ? 'glb-vps-1' : item.edgeId;
  const server = await getServerById(panelId).catch(() => null);
  if (server) {
    const { upsertServer } = await import('../lib/db-store.js');
    await upsertServer(panelId, {
      ...server,
      minInstances: RELAY_EDGE_DEFAULTS.minInstances,
      maxInstances: item.maxInstances,
      updatedAt: nowIso(),
    });
  }

  results.push({ ok: true, ...item, host: deploy.host, image: deploy.image });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dryRun: DRY_RUN,
      tunedAt: nowIso(),
      targets: results,
    },
    null,
    2
  )
);
