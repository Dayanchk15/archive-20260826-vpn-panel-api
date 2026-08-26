#!/usr/bin/env node
/**
 * Restore FR1 edge only: public VLESS WS :8088 + rollback relay WS upstream.
 */
import { writeFileSync, existsSync } from 'fs';
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
const UPSTREAM = 'ws://185.209.230.14:8088/';
const FR1_IP = '185.209.230.14';
const FR1_PORT = 8088;

const sshKeyCandidates = [
  process.env.RELAY_EDGE_SSH_KEY,
  '/run/secrets/id_ed25519_edge',
  '/run/edge-ssh/id_ed25519',
].filter(Boolean);

function resolveSshKey() {
  for (const c of sshKeyCandidates) {
    if (existsSync(c)) return c;
  }
  return sshKeyCandidates[0] || '/run/secrets/id_ed25519_edge';
}

function run(cmd, args, input = '', timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
    });
    child.on('error', reject);
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

const clients = await buildEdgeClientList();
const config = withBlockQuicRouting({
  log: { loglevel: 'error' },
  inbounds: [
    {
      listen: '0.0.0.0',
      port: FR1_PORT,
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
      streamSettings: {
        network: 'ws',
        wsSettings: { path: '/' },
      },
    },
  ],
  outbounds: [{ protocol: 'freedom', tag: 'direct' }],
});

const localConfig = '/tmp/fr1-restore-config.json';
writeFileSync(localConfig, JSON.stringify(config, null, 2));

const sshKey = resolveSshKey();
const scpArgs = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'ConnectTimeout=20',
  '-i',
  sshKey,
  localConfig,
  `root@${FR1_IP}:/opt/vpn-relay-edge/config.json`,
];
console.log(JSON.stringify({ step: 'scp_config', key: sshKey }));
await run('scp', scpArgs);

const remoteScript = `set -euo pipefail
systemctl stop vpn-fr1-tcp-ws-bridge 2>/dev/null || true
systemctl disable vpn-fr1-tcp-ws-bridge 2>/dev/null || true
pkill -f websocat 2>/dev/null || true
pkill -f 'xray run' 2>/dev/null || true
sleep 1
/usr/local/bin/xray run -test -config /opt/vpn-relay-edge/config.json
nohup /usr/local/bin/xray run -c /opt/vpn-relay-edge/config.json >/var/log/vpn-relay-edge.log 2>&1 &
sleep 2
ss -tlnp | grep ':${FR1_PORT}\\b' || (echo 'no listen ${FR1_PORT}' && exit 1)
echo OK_FR1_EDGE
`;

const sshArgs = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'ConnectTimeout=20',
  '-i',
  sshKey,
  `root@${FR1_IP}`,
  'bash',
  '-s',
];
console.log(JSON.stringify({ step: 'restart_xray' }));
const edge = await run('ssh', sshArgs, remoteScript);
console.log(edge.stdout.trim());

console.log(JSON.stringify({ step: 'deploy_relay_ws' }));
const deploy = await deployVpnWsRelay(PROFILE_ID, {
  serviceName: 'gcp2-relay-eu-fr1',
  region: 'europe-west1',
  upstreamWsUrl: UPSTREAM,
  cpu: 1,
  memory: '1Gi',
  minInstances: Number(process.env.FR1_MIN_INSTANCES ?? 1),
  maxInstances: 2,
  cpuThrottling: false,
  sessionAffinity: true,
  maxInstanceRequestConcurrency: 8,
  timeoutSeconds: 3600,
  skipBuild: true,
  image: IMAGE,
});

const panel = await getServerById('gcp2-eu-fr1');
await upsertServer('gcp2-eu-fr1', {
  ...panel,
  enabled: true,
  host: deploy.host,
  relayUpstream: UPSTREAM,
  relayUpstreamMode: 'ws',
  region: 'europe-west1',
  cloudRunRegion: 'europe-west1',
  minInstances: Number(process.env.FR1_MIN_INSTANCES ?? 1),
  updatedAt: nowIso(),
});

await new Promise((r) => setTimeout(r, 20000));
const maskedIp = String((await getPanelSettings()).addressIps?.[0] || '216.58.198.50').trim();
const probe = await probeMaskedTls(await getServerById('gcp2-eu-fr1'), maskedIp, 20000);

console.log(
  JSON.stringify(
    {
      ok: probe.ok,
      edge: edge.stdout.includes('OK_FR1_EDGE'),
      deploy: deploy.host,
      probe,
      clients: clients.length,
    },
    null,
    2
  )
);

if (!probe.ok) process.exitCode = 1;
