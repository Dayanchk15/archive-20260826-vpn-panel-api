#!/usr/bin/env node
/** FR1 only: cold relay (min=0) to avoid west1 429, keep VPS edge warm. */
import { deployVpnWsRelay } from '/app/lib/cloud-run-relay-deploy.js';
import { getServerById, upsertServer } from '/app/lib/db-store.js';
import { probeMaskedTls } from '/app/lib/masked-tls-probe.js';
import { getPanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';

const IMAGE =
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest';

const d = await deployVpnWsRelay('gcp-75063f06', {
  serviceName: 'gcp2-relay-eu-fr1',
  region: 'europe-west1',
  upstreamWsUrl: 'ws://185.209.230.14:8088/',
  minInstances: 0,
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

const p = await getServerById('gcp2-eu-fr1');
await upsertServer('gcp2-eu-fr1', {
  ...p,
  enabled: true,
  host: d.host,
  minInstances: 0,
  maxInstances: 2,
  updatedAt: nowIso(),
});

await new Promise((r) => setTimeout(r, 45000));
const ip = String((await getPanelSettings()).addressIps?.[0] || '216.58.198.50');
const probe1 = await probeMaskedTls(await getServerById('gcp2-eu-fr1'), ip, 25000);
await new Promise((r) => setTimeout(r, 5000));
const probe2 = await probeMaskedTls(await getServerById('gcp2-eu-fr1'), ip, 25000);

console.log(JSON.stringify({ host: d.host, probe1, probe2 }, null, 2));
