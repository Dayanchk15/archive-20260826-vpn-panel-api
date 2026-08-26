#!/usr/bin/env node
/**
 * Align all 8 GCP2 relays: tcp-relay-v1 + RELAY_WS_PING_MS=10000.
 *   SKIP_VPS=1 docker exec vpn-panel-api-vps env SKIP_VPS=1 SKIP_BUILD=1 RELAY_WS_PING_MS=10000 node /data/files/fix-relay-tcp-ping-all8.mjs
 */
import { getServerById, upsertServer } from '/app/lib/db-store.js';
import { probeMaskedTls } from '/app/lib/masked-tls-probe.js';
import { getPanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';
import { RELAY_WS_PATH } from '/app/lib/xray-tcp-edge-config.js';
import { TAMPA_EDGE } from '/app/lib/relay-edge-registry.js';
import {
  RELAY_EDGE_DEFAULTS,
  activeEuEdges,
  edgeRelayRegion,
  edgeRelayServiceName,
} from '/app/scripts/eu-relay-dayanch/config.mjs';
import { edgeTcpUpstreamAddr } from '/app/lib/xray-tcp-edge-config.js';

const PROFILE_ID = 'gcp-75063f06';
const IMAGE =
  process.env.RELAY_IMAGE ||
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:tcp-relay-v1';
const DEPLOY_GAP_MS = Number(process.env.DEPLOY_GAP_MS || 12000);
const PING_MS = String(process.env.RELAY_WS_PING_MS || '10000');

process.env.RELAY_WS_PING_MS = PING_MS;

const { deployVpnWsRelay } = await import('/app/lib/cloud-run-relay-deploy.js');

const GCP2_IDS = new Set(
  'gcp2-eu-nl,gcp2-eu-de,gcp2-eu-am,gcp2-eu-gb,gcp2-eu-de2,gcp2-eu-fr1,gcp2-eu-fr2,gcp2-usa'.split(',')
);

function panelId(edgeId) {
  return `gcp2-${String(edgeId).replace(/^relay-/, '')}`;
}

const servers = await Promise.all([...GCP2_IDS].map((id) => getServerById(id)));
const serverById = new Map(servers.filter(Boolean).map((s) => [String(s.id), s]));

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
    upstreamAddr: edgeTcpUpstreamAddr(edge.ip, edge.port),
    minInstances: Number(panelServer.minInstances ?? RELAY_EDGE_DEFAULTS.minInstances),
    maxInstances: Number(panelServer.maxInstances ?? RELAY_EDGE_DEFAULTS.maxInstances),
    concurrency: Number(panelServer.maxInstanceRequestConcurrency ?? RELAY_EDGE_DEFAULTS.maxInstanceRequestConcurrency),
  });
}

const usa = serverById.get('gcp2-usa');
if (usa && usa.enabled !== false) {
  queue.push({
    panelId: 'gcp2-usa',
    serviceName: String(usa.service || 'gcp2-tampa-relay').trim(),
    region: String(usa.region || 'us-central1').trim(),
    upstreamAddr: edgeTcpUpstreamAddr(TAMPA_EDGE.ip, TAMPA_EDGE.edgePort || 8080),
    minInstances: Number(usa.minInstances ?? 1),
    maxInstances: Number(usa.maxInstances ?? 2),
    concurrency: Number(usa.maxInstanceRequestConcurrency ?? 16),
  });
}

const panelSettings = await getPanelSettings();
const maskedIp = String(panelSettings.maskedAddressIp || '216.58.198.50').trim();
const results = [];

for (let i = 0; i < queue.length; i++) {
  const item = queue[i];
  if (i > 0 && DEPLOY_GAP_MS > 0) {
    await new Promise((r) => setTimeout(r, DEPLOY_GAP_MS));
  }

  const deploy = await deployVpnWsRelay(PROFILE_ID, {
    serviceName: item.serviceName,
    region: item.region,
    upstreamMode: 'tcp',
    upstreamAddr: item.upstreamAddr,
    wsPath: RELAY_WS_PATH,
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

  let probe = null;
  try {
    probe = await probeMaskedTls(
      { host: deploy.host, service: item.serviceName, path: RELAY_WS_PATH },
      maskedIp
    );
  } catch (err) {
    probe = { ok: false, error: err.message };
  }

  const existing = await getServerById(item.panelId);
  if (existing) {
    await upsertServer(item.panelId, {
      ...existing,
      host: deploy.host,
      region: item.region,
      path: RELAY_WS_PATH,
      network: 'ws',
      relayUpstreamMode: 'tcp',
      relayUpstreamAddr: item.upstreamAddr,
      cloudRunProfileId: PROFILE_ID,
      updatedAt: nowIso(),
    });
  }

  results.push({
    ok: true,
    panelId: item.panelId,
    serviceName: item.serviceName,
    region: item.region,
    image: IMAGE,
    relayWsPingMs: PING_MS,
    host: deploy.host,
    upstreamAddr: item.upstreamAddr,
    probe,
  });
}

console.log(JSON.stringify({ ok: true, relayWsPingMs: PING_MS, image: IMAGE, targets: results }, null, 2));
