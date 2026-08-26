#!/usr/bin/env node
/**
 * Panel-only: point relay-eu-* server records at per-edge Cloud Run hosts.
 * Run after deploy-eu-per-edge-relays.mjs (GCP already deployed).
 *
 *   docker exec vpn-panel-api-vps node /app/scripts/patch-eu-per-edge-relays-panel.mjs
 *
 * Env RELAY_HOSTS_JSON = JSON map edgeId -> host (optional override)
 */
import { getServerById, upsertServer } from '../lib/db-store.js';
import { nowIso } from '../lib/dates.js';
import {
  PROFILE_ID,
  RELAY_EDGE_DEFAULTS,
  activeEuEdges,
  edgeRelayRegion,
  edgeRelayServiceName,
  edgeUpstreamWsUrl,
} from './eu-relay-dayanch/config.mjs';

const defaultHosts = {
  'relay-eu-nl': 'relay-eu-nl-phmuswjaga-ez.a.run.app',
  'relay-eu-de': 'relay-eu-de-phmuswjaga-ez.a.run.app',
  'relay-eu-am': 'relay-eu-am-phmuswjaga-ez.a.run.app',
  'relay-eu-gb': 'relay-eu-gb-phmuswjaga-ez.a.run.app',
  'relay-eu-de2': 'relay-eu-de2-phmuswjaga-ez.a.run.app',
};

const hosts = process.env.RELAY_HOSTS_JSON
  ? JSON.parse(process.env.RELAY_HOSTS_JSON)
  : defaultHosts;

const activeIds = String(process.env.ACTIVE_EDGE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const edges = activeIds.length
  ? activeEuEdges().filter((e) => activeIds.includes(e.id))
  : activeEuEdges().filter((e) => hosts[e.id]);

const updated = [];
for (const edge of edges) {
  const host = String(hosts[edge.id] || '').trim();
  if (!host) continue;
  const serviceName = edgeRelayServiceName(edge);
  const region = edgeRelayRegion(edge);
  const existing = await getServerById(edge.id);
  await upsertServer(edge.id, {
    id: edge.id,
    name: edge.name,
    country: edge.country,
    flag: edge.flag,
    host,
    service: serviceName,
    cloudRunService: serviceName,
    region,
    cloudRunRegion: region,
    addressIp: '',
    port: 443,
    protocol: 'vless',
    network: 'ws',
    path: RELAY_EDGE_DEFAULTS.path,
    security: 'tls',
    sni: 'www.google.com',
    fingerprint: 'chrome',
    alpn: 'http/1.1',
    enabled: true,
    sortOrder: edge.sortOrder,
    cpu: RELAY_EDGE_DEFAULTS.cpu,
    memory: RELAY_EDGE_DEFAULTS.memory,
    minInstances: RELAY_EDGE_DEFAULTS.minInstances,
    maxInstances: RELAY_EDGE_DEFAULTS.maxInstances,
    timeoutSeconds: RELAY_EDGE_DEFAULTS.timeoutSeconds,
    cloudRunProfileId: PROFILE_ID,
    newUsersOnly: true,
    relayPilot: true,
    externalVps: true,
    relayUpstream: edgeUpstreamWsUrl(edge),
    relayEdgeNode: edge.node,
    perEdgeRelay: true,
    updatedAt: nowIso(),
    createdAt: existing?.createdAt || nowIso(),
  });
  updated.push({ id: edge.id, host, service: serviceName });
}

console.log(JSON.stringify({ ok: true, updated, note: 'Subscriptions NOT refreshed — pull in Happ to update.' }, null, 2));
