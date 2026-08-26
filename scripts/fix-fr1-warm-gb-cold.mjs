#!/usr/bin/env node
/** Free west1 quota: GB cold, FR1 warm. USA/others unchanged except these 2. */
import { deployVpnWsRelay } from '/app/lib/cloud-run-relay-deploy.js';
import { getServerById, upsertServer } from '/app/lib/db-store.js';
import { probeMaskedTls } from '/app/lib/masked-tls-probe.js';
import { getPanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';

const IMAGE =
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest';

const CHANGES = [
  { id: 'gcp2-eu-gb', service: 'gcp2-relay-eu-gb', region: 'europe-west1', up: 'ws://185.169.234.182:8084/', min: 0 },
  { id: 'gcp2-eu-fr1', service: 'gcp2-relay-eu-fr1', region: 'europe-west1', up: 'ws://185.209.230.14:8088/', min: 1 },
];

for (const t of CHANGES) {
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
    maxInstanceRequestConcurrency: 8,
    timeoutSeconds: 3600,
  });
  const p = await getServerById(t.id);
  await upsertServer(t.id, { ...p, enabled: true, host: d.host, minInstances: t.min, updatedAt: nowIso() });
  console.log(JSON.stringify({ id: t.id, min: t.min, host: d.host }));
  await new Promise((r) => setTimeout(r, 15000));
}

await new Promise((r) => setTimeout(r, 40000));
const ip = String((await getPanelSettings()).addressIps?.[0] || '216.58.198.50');
for (const id of ['gcp2-eu-fr1', 'gcp2-eu-gb', 'gcp2-usa']) {
  const r = await probeMaskedTls(await getServerById(id), ip, 25000);
  console.log(JSON.stringify({ id, ok: r.ok, status: r.status, ms: r.ms }));
}
