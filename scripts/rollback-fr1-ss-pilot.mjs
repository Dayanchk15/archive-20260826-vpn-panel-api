#!/usr/bin/env node
/**
 * Rollback FR1 to WS upstream (restore pre-pilot relay env).
 */
import { deployVpnWsRelay } from '/app/lib/cloud-run-relay-deploy.js';
import { getServerById, upsertServer } from '/app/lib/db-store.js';
import { probeMaskedTls } from '/app/lib/masked-tls-probe.js';
import { getPanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';

const PROFILE_ID = 'gcp-75063f06';
const IMAGE =
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest';
const UPSTREAM = 'ws://185.209.230.14:8088/';

const deploy = await deployVpnWsRelay(PROFILE_ID, {
  serviceName: 'gcp2-relay-eu-fr1',
  region: 'europe-west1',
  upstreamWsUrl: UPSTREAM,
  skipBuild: true,
  image: IMAGE,
  cpu: 1,
  memory: '1Gi',
  minInstances: 1,
  maxInstances: 2,
  cpuThrottling: false,
  sessionAffinity: true,
  maxInstanceRequestConcurrency: 20,
  timeoutSeconds: 3600,
});

const panel = await getServerById('gcp2-eu-fr1');
await upsertServer('gcp2-eu-fr1', {
  ...panel,
  host: deploy.host,
  relayUpstream: UPSTREAM,
  relayUpstreamMode: 'ws',
  updatedAt: nowIso(),
});

await new Promise((r) => setTimeout(r, 45000));
const ip = String((await getPanelSettings()).addressIps?.[0] || '216.58.198.50').trim();
const probe = await probeMaskedTls(await getServerById('gcp2-eu-fr1'), ip, 25000);
console.log(JSON.stringify({ ok: probe.ok, deploy: deploy.host, probe }, null, 2));
if (!probe.ok) process.exitCode = 1;
