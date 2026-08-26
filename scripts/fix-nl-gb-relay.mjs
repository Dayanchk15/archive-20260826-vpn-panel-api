#!/usr/bin/env node
import { deployVpnWsRelay } from '../lib/cloud-run-relay-deploy.js';
import { getServerById, upsertServer } from '../lib/db-store.js';
import { nowIso } from '../lib/dates.js';
import { RELAY_EDGE_DEFAULTS, EU_EDGES } from './eu-relay-dayanch/config.mjs';

const PROFILE_ID = 'gcp-75063f06';
const IMAGE =
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest';
const FIX = new Set(['relay-eu-nl', 'relay-eu-gb']);

for (const edge of EU_EDGES.filter((e) => FIX.has(e.id))) {
  const panelId = `gcp2-${edge.id.replace(/^relay-/, '')}`;
  const panel = await getServerById(panelId);
  const serviceName = String(panel?.service || `gcp2-${edge.id}`).trim();
  console.log(JSON.stringify({ step: 'redeploy', panelId, serviceName, ip: edge.ip, port: edge.port }));

  const deploy = await deployVpnWsRelay(PROFILE_ID, {
    serviceName,
    region: 'europe-west4',
    upstreamWsUrl: `ws://${edge.ip}:${edge.port}/`,
    cpu: RELAY_EDGE_DEFAULTS.cpu,
    memory: RELAY_EDGE_DEFAULTS.memory,
    minInstances: 0,
    maxInstances: 1,
    cpuThrottling: false,
    sessionAffinity: true,
    maxInstanceRequestConcurrency: 8,
    timeoutSeconds: RELAY_EDGE_DEFAULTS.timeoutSeconds,
    skipBuild: true,
    image: IMAGE,
  });

  await upsertServer(panelId, {
    ...panel,
    enabled: true,
    host: deploy.host,
    service: serviceName,
    cloudRunService: serviceName,
    minInstances: 0,
    maxInstances: 1,
    updatedAt: nowIso(),
  });
  console.log(JSON.stringify({ ok: true, panelId, host: deploy.host }));
}
