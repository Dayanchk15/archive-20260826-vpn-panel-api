#!/usr/bin/env node
/**
 * Rollback TCP relay to WS→WS on all 8 GCP2 lines.
 *
 *   DRY_RUN=1 node scripts/rollback-tcp-relay-all-8.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { deployVpnWsRelay } from '../lib/cloud-run-relay-deploy.js';
import { getServerById, listServers, upsertServer } from '../lib/db-store.js';
import { probeMaskedTls } from '../lib/masked-tls-probe.js';
import { getPanelSettings } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';
import { TAMPA_EDGE } from '../lib/relay-edge-registry.js';
import {
  RELAY_EDGE_DEFAULTS,
  activeEuEdges,
  edgeRelayRegion,
  edgeRelayServiceName,
  edgeUpstreamWsUrl,
} from './eu-relay-dayanch/config.mjs';

const PROFILE_ID = 'gcp-75063f06';
const IMAGE =
  process.env.RELAY_IMAGE ||
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest';
const DRY_RUN = ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN || '').toLowerCase());
const DEPLOY_GAP_MS = Number(process.env.DEPLOY_GAP_MS || 10000);

process.env.RELAY_WS_PING_MS = String(RELAY_EDGE_DEFAULTS.wsPingMs || 25000);

const GCP2_IDS = new Set(
  'gcp2-eu-nl,gcp2-eu-de,gcp2-eu-am,gcp2-eu-gb,gcp2-eu-de2,gcp2-eu-fr1,gcp2-eu-fr2,gcp2-usa'
    .split(',')
    .map((s) => s.trim())
);

function panelId(edgeId) {
  return `gcp2-${String(edgeId).replace(/^relay-/, '')}`;
}

const servers = await listServers();
const serverById = new Map(servers.map((s) => [String(s.id), s]));
const panelSettings = await getPanelSettings();

const queue = [];
for (const edge of activeEuEdges()) {
  const pid = panelId(edge.id);
  if (!GCP2_IDS.has(pid)) continue;
  const panelServer = serverById.get(pid);
  if (!panelServer || panelServer.enabled === false) continue;
  queue.push({
    panelId: pid,
    serviceName: String(panelServer.service || panelServer.cloudRunService || edgeRelayServiceName(edge)).trim(),
    region: edgeRelayRegion(edge),
    upstreamWsUrl: edgeUpstreamWsUrl(edge),
    minInstances: Number(panelServer.minInstances ?? RELAY_EDGE_DEFAULTS.minInstances),
    maxInstances: Number(panelServer.maxInstances ?? RELAY_EDGE_DEFAULTS.maxInstances),
    concurrency: Number(
      panelServer.maxInstanceRequestConcurrency ?? RELAY_EDGE_DEFAULTS.maxInstanceRequestConcurrency
    ),
  });
}

const usa = serverById.get('gcp2-usa');
if (usa && usa.enabled !== false) {
  queue.push({
    panelId: 'gcp2-usa',
    serviceName: String(usa.service || 'gcp2-tampa-relay').trim(),
    region: String(usa.region || 'us-central1').trim(),
    upstreamWsUrl: `ws://${TAMPA_EDGE.ip}:${TAMPA_EDGE.port}/`,
    minInstances: Number(usa.minInstances ?? 1),
    maxInstances: Number(usa.maxInstances ?? 1),
    concurrency: Number(usa.maxInstanceRequestConcurrency ?? 16),
  });
}

const results = [];
for (let i = 0; i < queue.length; i++) {
  const item = queue[i];
  if (DRY_RUN) {
    results.push({ ...item, dryRun: true });
    continue;
  }
  if (i > 0 && DEPLOY_GAP_MS > 0) await new Promise((r) => setTimeout(r, DEPLOY_GAP_MS));

  const deploy = await deployVpnWsRelay(PROFILE_ID, {
    serviceName: item.serviceName,
    region: item.region,
    upstreamWsUrl: item.upstreamWsUrl,
    wsPath: '/',
    cpu: RELAY_EDGE_DEFAULTS.cpu,
    memory: RELAY_EDGE_DEFAULTS.memory,
    minInstances: item.minInstances,
    maxInstances: item.maxInstances,
    cpuThrottling: false,
    sessionAffinity: true,
    maxInstanceRequestConcurrency: item.concurrency,
    timeoutSeconds: RELAY_EDGE_DEFAULTS.timeoutSeconds,
    skipBuild: true,
    image: IMAGE,
  });

  const probe = await probeMaskedTls(
    { host: deploy.host, service: item.serviceName, path: '/' },
    panelSettings.maskedAddressIp
  );

  const existing = await getServerById(item.panelId);
  if (existing) {
    await upsertServer(item.panelId, {
      ...existing,
      host: deploy.host,
      path: '/',
      relayUpstreamMode: 'ws',
      relayUpstreamAddr: null,
      updatedAt: nowIso(),
    });
  }

  results.push({ ok: true, ...item, host: deploy.host, probe });
}

console.log(JSON.stringify({ ok: true, dryRun: DRY_RUN, rolledBackAt: nowIso(), targets: results }, null, 2));
