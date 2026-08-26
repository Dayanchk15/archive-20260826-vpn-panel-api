#!/usr/bin/env node
/** Redeploy FR1 + USA Cloud Run only. No other lines. No sub refresh. */
import { deployVpnWsRelay } from '/app/lib/cloud-run-relay-deploy.js';
import { getServerById, upsertServer } from '/app/lib/db-store.js';
import { probeMaskedTls } from '/app/lib/masked-tls-probe.js';
import { getPanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';

const IMAGE =
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest';

const TARGETS = [
  { id: 'gcp2-eu-fr1', service: 'gcp2-relay-eu-fr1', region: 'europe-west1', up: 'ws://185.209.230.14:8088/', min: 1, conc: 8 },
  { id: 'gcp2-usa', service: 'gcp2-tampa-relay', region: 'us-central1', up: 'ws://74.115.172.101:8080/', min: 1, conc: 16 },
];

for (const t of TARGETS) {
  const d = await deployVpnWsRelay('gcp-75063f06', {
    serviceName: t.service,
    region: t.region,
    upstreamWsUrl: t.up,
    minInstances: t.min,
    maxInstances: 2,
    skipBuild: true,
    image: IMAGE,
    cpu: 1,
    memory: '1Gi',
    cpuThrottling: false,
    sessionAffinity: true,
    maxInstanceRequestConcurrency: t.conc,
    timeoutSeconds: 3600,
  });
  const p = await getServerById(t.id);
  await upsertServer(t.id, {
    ...p,
    enabled: true,
    host: d.host,
    network: 'ws',
    path: '/',
    relayUpstream: t.up,
    relayUpstreamMode: 'ws',
    minInstances: t.min,
    updatedAt: nowIso(),
  });
  console.log(JSON.stringify({ id: t.id, host: d.host }));
  await new Promise((r) => setTimeout(r, 15000));
}

await new Promise((r) => setTimeout(r, 30000));
const ip = String((await getPanelSettings()).addressIps?.[0] || '216.58.198.50');
for (const t of TARGETS) {
  const p = await probeMaskedTls(await getServerById(t.id), ip, 25000);
  console.log(JSON.stringify({ id: t.id, ok: p.ok, ms: p.ms, status: p.status }));
}
