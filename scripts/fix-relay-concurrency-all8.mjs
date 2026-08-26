#!/usr/bin/env node
/**
 * Fix Cloud Run scaling for VPN relay: concurrency=30, max=3, quota-safe warm.
 *
 * Regional warm caps (GCP minInstances quota):
 *   europe-west4  ≤ 2  → NL + AM warm, GB cold
 *   europe-west1  ≤ 3  → DE + DE2 + FR1 warm
 *   us-central1   ≤ 1  → USA warm, FR2 cold
 *
 *   docker exec vpn-panel-api-vps node /data/files/fix-relay-concurrency-all8.mjs
 */
import { getServerById, upsertServer } from '/app/lib/db-store.js';
import { probeMaskedTls } from '/app/lib/masked-tls-probe.js';
import { getPanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';
import { RELAY_WS_PATH } from '/app/lib/xray-tcp-edge-config.js';
import { edgeTcpUpstreamAddr } from '/app/lib/xray-tcp-edge-config.js';
import { TAMPA_EDGE } from '/app/lib/relay-edge-registry.js';
import {
  RELAY_EDGE_DEFAULTS,
  activeEuEdges,
  edgeRelayRegion,
  edgeRelayServiceName,
} from '/app/scripts/eu-relay-dayanch/config.mjs';

const PROFILE_ID = 'gcp-75063f06';
const IMAGE =
  process.env.RELAY_IMAGE ||
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:tcp-relay-v1';
const DEPLOY_GAP_MS = Number(process.env.DEPLOY_GAP_MS || 12000);
const PING_MS = String(process.env.RELAY_WS_PING_MS || '10000');
const CONCURRENCY = Number(process.env.RELAY_CONCURRENCY || 30);
const MAX_INSTANCES = Number(process.env.RELAY_MAX_INSTANCES || 3);

process.env.RELAY_WS_PING_MS = PING_MS;

const { deployVpnWsRelay } = await import('/app/lib/cloud-run-relay-deploy.js');

/** Quota-safe minInstances per panel server id. */
const MIN_BY_ID = {
  'gcp2-eu-nl': 1,
  'gcp2-eu-am': 1,
  'gcp2-eu-gb': 0,
  'gcp2-eu-de': 1,
  'gcp2-eu-de2': 1,
  'gcp2-eu-fr1': 1,
  'gcp2-eu-fr2': 0,
  'gcp2-usa': 1,
};

/** FR1 first (no available instance), then west1, west4, us-central1. */
const DEPLOY_ORDER = [
  'gcp2-eu-fr1',
  'gcp2-eu-de',
  'gcp2-eu-de2',
  'gcp2-eu-nl',
  'gcp2-eu-am',
  'gcp2-eu-gb',
  'gcp2-usa',
  'gcp2-eu-fr2',
];

const GCP2_IDS = new Set(Object.keys(MIN_BY_ID));

function panelId(edgeId) {
  return `gcp2-${String(edgeId).replace(/^relay-/, '')}`;
}

const servers = await Promise.all([...GCP2_IDS].map((id) => getServerById(id)));
const serverById = new Map(servers.filter(Boolean).map((s) => [String(s.id), s]));

const byId = new Map();

for (const edge of activeEuEdges()) {
  const pid = panelId(edge.id);
  if (!GCP2_IDS.has(pid)) continue;
  const panelServer = serverById.get(pid);
  if (!panelServer || panelServer.enabled === false) continue;
  byId.set(pid, {
    panelId: pid,
    serviceName: String(panelServer.service || panelServer.cloudRunService || edgeRelayServiceName(edge)).trim(),
    region: edgeRelayRegion(edge),
    upstreamAddr: edgeTcpUpstreamAddr(edge.ip, edge.port),
    minInstances: MIN_BY_ID[pid] ?? 0,
  });
}

const usa = serverById.get('gcp2-usa');
if (usa && usa.enabled !== false) {
  byId.set('gcp2-usa', {
    panelId: 'gcp2-usa',
    serviceName: String(usa.service || 'gcp2-tampa-relay').trim(),
    region: String(usa.region || 'us-central1').trim(),
    upstreamAddr: edgeTcpUpstreamAddr(TAMPA_EDGE.ip, TAMPA_EDGE.edgePort || 8080),
    minInstances: MIN_BY_ID['gcp2-usa'],
  });
}

const queue = DEPLOY_ORDER.map((id) => byId.get(id)).filter(Boolean);

const panelSettings = await getPanelSettings();
const maskedIp = String(panelSettings.maskedAddressIp || '216.58.198.50').trim();
const results = [];

console.log(
  JSON.stringify({
    plan: {
      concurrency: CONCURRENCY,
      maxInstances: MAX_INSTANCES,
      relayWsPingMs: PING_MS,
      warmByRegion: {
        'europe-west4': queue.filter((q) => q.region === 'europe-west4' && q.minInstances > 0).map((q) => q.panelId),
        'europe-west1': queue.filter((q) => q.region === 'europe-west1' && q.minInstances > 0).map((q) => q.panelId),
        'us-central1': queue.filter((q) => q.region === 'us-central1' && q.minInstances > 0).map((q) => q.panelId),
      },
      cold: queue.filter((q) => q.minInstances === 0).map((q) => q.panelId),
    },
  })
);

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
    maxInstances: MAX_INSTANCES,
    cpuThrottling: false,
    sessionAffinity: true,
    maxInstanceRequestConcurrency: CONCURRENCY,
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
      minInstances: item.minInstances,
      maxInstances: MAX_INSTANCES,
      maxInstanceRequestConcurrency: CONCURRENCY,
      updatedAt: nowIso(),
    });
  }

  results.push({
    ok: true,
    panelId: item.panelId,
    serviceName: item.serviceName,
    region: item.region,
    minInstances: item.minInstances,
    maxInstances: MAX_INSTANCES,
    concurrency: CONCURRENCY,
    relayWsPingMs: PING_MS,
    host: deploy.host,
    probe,
  });

  console.log(JSON.stringify(results[results.length - 1]));
}

console.log(JSON.stringify({ ok: true, targets: results }, null, 2));
