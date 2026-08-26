#!/usr/bin/env node
/**
 * Fix FR1 + USA only: redeploy 2 Cloud Run relays, refresh 2 VPS edges.
 * Does NOT touch other 6 lines. No mass subscription refresh.
 */
import { writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { deployVpnWsRelay } from '/app/lib/cloud-run-relay-deploy.js';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';
import { getServerById, upsertServer } from '/app/lib/db-store.js';
import { probeMaskedTls } from '/app/lib/masked-tls-probe.js';
import { getPanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';
import { withBlockQuicRouting } from '/app/lib/xray-routing.js';

const PROFILE_ID = 'gcp-75063f06';
const IMAGE =
  'europe-west4-docker.pkg.dev/project-75063f06-80ed-4a6d-97b/vpn-panel/vpn-ws-relay-go:latest';

const TARGETS = [
  {
    id: 'gcp2-eu-fr1',
    service: 'gcp2-relay-eu-fr1',
    region: 'europe-west1',
    upstream: 'ws://185.209.230.14:8088/',
    vps: '185.209.230.14',
    port: 8088,
    min: 1,
    concurrency: 8,
  },
  {
    id: 'gcp2-usa',
    service: 'gcp2-tampa-relay',
    region: 'us-central1',
    upstream: 'ws://74.115.172.101:8080/',
    vps: '74.115.172.101',
    port: 8080,
    min: 1,
    concurrency: 16,
  },
];

function buildEdgeConfig(port, clients) {
  return withBlockQuicRouting({
    log: { loglevel: 'error' },
    inbounds: [
      {
        listen: '0.0.0.0',
        port,
        protocol: 'vless',
        tag: 'vless-ws',
        settings: {
          clients: clients.map((c) => ({
            id: c.uuid,
            email: c.email || c.name || c.userId || c.uuid,
            level: 0,
          })),
          decryption: 'none',
        },
        streamSettings: { network: 'ws', wsSettings: { path: '/' } },
      },
    ],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  });
}

function sshApply(vps, port, configJson) {
  return new Promise((resolve, reject) => {
    const remote = `set -euo pipefail
cat > /opt/vpn-relay-edge/config.json <<'EOF_CFG'
${configJson}
EOF_CFG
/usr/local/bin/xray run -test -config /opt/vpn-relay-edge/config.json
pkill -f 'xray run' 2>/dev/null || true
sleep 1
nohup /usr/local/bin/xray run -c /opt/vpn-relay-edge/config.json >/var/log/vpn-relay-edge.log 2>&1 &
sleep 2
ss -tlnp | grep ':${port}\\b' || exit 1
echo OK_EDGE_${port}
`;
    const child = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=25', `root@${vps}`, 'bash', '-s'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `ssh exit ${code}`));
    });
    child.on('error', reject);
    child.stdin.write(remote);
    child.stdin.end();
  });
}

const clients = await buildEdgeClientList();
const results = [];

for (const t of TARGETS) {
  console.log(JSON.stringify({ step: 'edge', id: t.id, vps: t.vps }));
  const cfg = JSON.stringify(buildEdgeConfig(t.port, clients), null, 2);
  const localPath = `/data/files/fix-edge-${t.id}.json`;
  writeFileSync(localPath, cfg);
  try {
    const edgeOut = await sshApply(t.vps, t.port, cfg);
    results.push({ id: t.id, edge: edgeOut.includes(`OK_EDGE_${t.port}`) });
  } catch (err) {
    results.push({ id: t.id, edge: false, edgeError: err.message });
  }

  console.log(JSON.stringify({ step: 'relay', id: t.id, service: t.service }));
  const deploy = await deployVpnWsRelay(PROFILE_ID, {
    serviceName: t.service,
    region: t.region,
    upstreamWsUrl: t.upstream,
    minInstances: t.min,
    maxInstances: 2,
    skipBuild: true,
    image: IMAGE,
    cpu: 1,
    memory: '1Gi',
    cpuThrottling: false,
    sessionAffinity: true,
    maxInstanceRequestConcurrency: t.concurrency,
    timeoutSeconds: 3600,
  });

  const panel = await getServerById(t.id);
  await upsertServer(t.id, {
    ...panel,
    enabled: true,
    host: deploy.host,
    network: 'ws',
    path: '/',
    grpcServiceName: null,
    pilotMode: null,
    relayUpstream: t.upstream,
    relayUpstreamMode: 'ws',
    minInstances: t.min,
    maxInstances: 2,
    updatedAt: nowIso(),
  });

  results.push({ id: t.id, relay: deploy.host });
  await new Promise((r) => setTimeout(r, 12000));
}

await new Promise((r) => setTimeout(r, 25000));
const maskedIp = String((await getPanelSettings()).addressIps?.[0] || '216.58.198.50').trim();
const probes = [];
for (const t of TARGETS) {
  const s = await getServerById(t.id);
  const p = await probeMaskedTls(s, maskedIp, 25000);
  probes.push({ id: t.id, ok: p.ok, status: p.status, ms: p.ms, error: p.error });
}

console.log(
  JSON.stringify(
    {
      ok: probes.every((p) => p.ok),
      fixed: TARGETS.map((t) => t.id),
      results,
      probes,
      clients: clients.length,
      note: 'Other 6 lines untouched. Refresh subscription in Happ if FR2/grpc cached.',
    },
    null,
    2
  )
);

if (!probes.every((p) => p.ok)) process.exitCode = 1;
