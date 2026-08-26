#!/usr/bin/env node
import { deployVpnWsRelay } from '../lib/cloud-run-relay-deploy.js';
import { getServerById, upsertServer } from '../lib/db-store.js';
import { nowIso } from '../lib/dates.js';

const panel = await getServerById('gcp2-eu-gb');
const deploy = await deployVpnWsRelay('gcp-75063f06', {
  serviceName: 'gcp2-relay-eu-gb',
  region: 'europe-west4',
  upstreamWsUrl: 'ws://185.169.234.182:8084/',
  cpu: 1,
  memory: '1Gi',
  minInstances: 0,
  maxInstances: 1,
  cpuThrottling: false,
  sessionAffinity: true,
  maxInstanceRequestConcurrency: 8,
  timeoutSeconds: 3600,
  skipBuild: true,
  image: 'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest',
});
await upsertServer('gcp2-eu-gb', {
  ...panel,
  enabled: true,
  host: deploy.host,
  minInstances: 0,
  maxInstances: 1,
  updatedAt: nowIso(),
});
console.log(JSON.stringify({ ok: true, host: deploy.host }));
