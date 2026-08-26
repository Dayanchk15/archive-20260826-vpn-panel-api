#!/usr/bin/env node
/** Warm only NL + DE + USA (TM priority), rest cold. 8 lines, 57 subs. */
import { deployVpnWsRelay } from '/app/lib/cloud-run-relay-deploy.js';
import { getServerById, listUsers, upsertServer } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { probeMaskedTls } from '/app/lib/masked-tls-probe.js';
import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';

const IMAGE =
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest';

const TARGETS = [
  { id: 'gcp2-eu-nl', service: 'gcp2-relay-eu-nl', region: 'europe-west4', up: 'ws://194.127.178.70:8081/', warm: true },
  { id: 'gcp2-eu-am', service: 'gcp2-relay-eu-am', region: 'europe-west4', up: 'ws://194.127.179.178:8083/', warm: false },
  { id: 'gcp2-eu-de', service: 'gcp2-relay-eu-de', region: 'europe-west1', up: 'ws://2.26.231.130:8082/', warm: true },
  { id: 'gcp2-eu-gb', service: 'gcp2-relay-eu-gb', region: 'europe-west1', up: 'ws://185.169.234.182:8084/', warm: false },
  { id: 'gcp2-eu-de2', service: 'gcp2-relay-eu-de2', region: 'europe-west1', up: 'ws://45.133.251.146:8085/', warm: false },
  { id: 'gcp2-eu-fr1', service: 'gcp2-relay-eu-fr1', region: 'europe-west1', up: 'ws://185.209.230.14:8088/', warm: false },
  { id: 'gcp2-eu-fr2', service: 'gcp2-relay-eu-fr2', region: 'europe-west1', up: 'ws://185.209.230.46:8089/', warm: false },
  { id: 'gcp2-usa', service: 'gcp2-tampa-relay', region: 'us-central1', up: 'ws://74.115.172.101:8080/', warm: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await updatePanelSettings({
  subscriptionWarmOnly: false,
  subscriptionMinServers: 8,
  subscriptionOnePerCountry: false,
});

for (const t of TARGETS) {
  const min = t.warm ? 1 : 0;
  const d = await deployVpnWsRelay('gcp-75063f06', {
    serviceName: t.service,
    region: t.region,
    upstreamWsUrl: t.up,
    minInstances: min,
    maxInstances: 2,
    skipBuild: true,
    image: IMAGE,
    cpu: 1,
    memory: '1Gi',
    cpuThrottling: false,
    sessionAffinity: true,
    maxInstanceRequestConcurrency: t.id === 'gcp2-usa' ? 16 : 8,
    timeoutSeconds: 3600,
  });
  const p = await getServerById(t.id);
  await upsertServer(t.id, {
    ...p,
    enabled: true,
    host: d.host,
    minInstances: min,
    maxInstances: 2,
    updatedAt: nowIso(),
  });
  console.log(JSON.stringify({ id: t.id, min }));
  await sleep(10000);
}

let subs = 0;
for (const u of await listUsers(10000)) {
  await upsertUserSubscriptionFile(u);
  subs++;
}

await sleep(12000);
const maskedIp = String((await getPanelSettings()).addressIps?.[0] || '216.58.198.50');
const probes = [];
for (const t of TARGETS) {
  const s = await getServerById(t.id);
  const p = await probeMaskedTls(s, maskedIp, 20000);
  probes.push({ id: t.id, min: t.warm ? 1 : 0, ok: p.ok, status: p.status, ms: p.ms });
}

console.log(
  JSON.stringify(
    {
      warm: TARGETS.filter((t) => t.warm).map((t) => t.id),
      subs,
      pingOk: probes.filter((p) => p.ok).map((p) => p.id),
      pingFail: probes.filter((p) => !p.ok),
      probes,
    },
    null,
    2
  )
);
