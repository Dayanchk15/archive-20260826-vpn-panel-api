#!/usr/bin/env node
/**
 * Install real upload/download reporters ONLY where Xray Stats API already works.
 * Does NOT restart any Xray process. Presence reporters stay as-is.
 */
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Origins with confirmed live Stats API from audit. */
const ORIGINS = [
  {
    host: '185.209.230.14',
    key: KEY,
    edgeDir: '/opt/vpn-cloudflare-ws',
    apiPort: 10094,
    nodeId: 'fr1-cloudflare-ws',
    unit: 'xray-traffic-fr1-cloudflare-ws',
  },
  {
    host: '185.209.230.46',
    key: KEY,
    edgeDir: '/opt/vpn-fr2-bunny-ws',
    apiPort: 10089,
    nodeId: 'fr2-bunny-ws',
    unit: 'xray-traffic-fr2-bunny-ws',
  },
  {
    host: '185.209.230.46',
    key: KEY,
    edgeDir: '/opt/vpn-fr2-cloudflare-grpc',
    apiPort: 10093,
    nodeId: 'fr2-cloudflare-grpc',
    unit: 'xray-traffic-fr2-cloudflare-grpc',
  },
  {
    host: '185.209.230.46',
    key: KEY,
    edgeDir: '/opt/vpn-cloudflare-ws',
    apiPort: 10094,
    nodeId: 'fr2-cloudflare-ws',
    unit: 'xray-traffic-fr2-cloudflare-ws',
  },
  {
    host: '74.115.172.101',
    key: null,
    edgeDir: '/opt/vpn-tampa-bunny-ws',
    apiPort: 10090,
    nodeId: 'tampa-bunny-ws',
    unit: 'xray-traffic-tampa-bunny-ws',
  },
  {
    host: '74.115.172.101',
    key: null,
    edgeDir: '/opt/vpn-tampa-cloudflare-grpc',
    apiPort: 10093,
    nodeId: 'tampa-cloudflare-grpc',
    unit: 'xray-traffic-tampa-cloudflare-grpc',
  },
  {
    host: '74.115.172.101',
    key: null,
    edgeDir: '/opt/vpn-cloudflare-ws',
    apiPort: 10094,
    nodeId: 'tampa-cloudflare-ws',
    unit: 'xray-traffic-tampa-cloudflare-ws',
  },
  {
    host: '130.17.12.61',
    key: null,
    edgeDir: '/opt/vpn-fornex-cloudflare-grpc',
    apiPort: 10093,
    nodeId: 'fornex-cloudflare-grpc',
    unit: 'xray-traffic-fornex-cloudflare-grpc',
  },
  {
    host: '130.17.12.61',
    key: null,
    edgeDir: '/opt/vpn-cloudflare-ws',
    apiPort: 10094,
    nodeId: 'fornex-cloudflare-ws',
    unit: 'xray-traffic-fornex-cloudflare-ws',
  },
];

const selectedOrigins = process.env.CF_WS_ONLY === '1'
  ? ORIGINS.filter((origin) => origin.edgeDir === '/opt/vpn-cloudflare-ws')
  : ORIGINS;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout ${cmd}`));
    }, opts.timeoutMs || 180000);
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
  });
}

function sshBase(host, key) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=15',
  ];
  if (key) args.push('-i', key);
  args.push(`root@${host}`);
  return args;
}

async function ssh(host, key, remoteCmd) {
  return run('ssh', [...sshBase(host, key), remoteCmd]);
}

async function scp(local, host, key, remote) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=20',
  ];
  if (key) args.push('-i', key);
  args.push(local, `root@${host}:${remote}`);
  return run('scp', args);
}

const { stdout: keyOut } = await run('ssh', [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=20',
  PANEL,
  "grep -E '^EDGE_REPORT_KEY=' /opt/vpn-panel-api-vps/.env.vps | head -1 | cut -d= -f2-",
]);
const reportKey = keyOut.trim();
if (!reportKey) throw new Error('EDGE_REPORT_KEY missing on panel');

const work = join(tmpdir(), 'live-stats-reporter');
mkdirSync(work, { recursive: true });
const reporterLocal = join(work, 'standalone-traffic-reporter.py');
const installerLocal = join(work, 'install-live-stats-traffic-reporter.sh');
const envLocal = join(work, 'pilot-report.env');
copyFileSync(join(ROOT, 'scripts', 'standalone-traffic-reporter.py'), reporterLocal);
copyFileSync(join(ROOT, 'scripts', 'install-live-stats-traffic-reporter.sh'), installerLocal);
writeFileSync(
  envLocal,
  `PANEL_REPORT_URL=https://sub.twidu.com/internal/traffic/report\nEDGE_REPORT_KEY=${reportKey}\n`
);

const hosts = [...new Set(selectedOrigins.map((o) => o.host))];
for (const host of hosts) {
  const key = selectedOrigins.find((o) => o.host === host)?.key || null;
  await scp(reporterLocal, host, key, '/tmp/standalone-traffic-reporter.py');
  await scp(installerLocal, host, key, '/tmp/install-live-stats-traffic-reporter.sh');
  await scp(envLocal, host, key, '/tmp/pilot-report.env');
  await ssh(host, key, "sed -i 's/\\r$//' /tmp/install-live-stats-traffic-reporter.sh && chmod 700 /tmp/install-live-stats-traffic-reporter.sh /tmp/standalone-traffic-reporter.py");
}

const results = [];
for (const origin of selectedOrigins) {
  const cmd = [
    'set -e',
    `export EDGE_DIR='${origin.edgeDir}'`,
    `export TRAFFIC_NODE_ID='${origin.nodeId}'`,
    `export XRAY_API_PORT='${origin.apiPort}'`,
    `export TRAFFIC_UNIT_NAME='${origin.unit}'`,
    'export REPORT_ENV=/tmp/pilot-report.env',
    'export XRAY_BIN=/usr/local/bin/xray',
    'bash /tmp/install-live-stats-traffic-reporter.sh',
  ].join('; ');
  try {
    // Confirm Xray PID unchanged around install.
    const before = await ssh(
      origin.host,
      origin.key,
      `pgrep -af 'xray.*${origin.edgeDir.replace(/\/opt\//, '')}' || pgrep -af 'xray.*${origin.edgeDir}' || true`
    );
    const { stdout } = await ssh(origin.host, origin.key, cmd);
    const after = await ssh(
      origin.host,
      origin.key,
      `pgrep -af 'xray.*${origin.edgeDir.replace(/\/opt\//, '')}' || pgrep -af 'xray.*${origin.edgeDir}' || true`
    );
    const beforePids = (before.stdout.match(/^\d+/gm) || []).sort().join(',');
    const afterPids = (after.stdout.match(/^\d+/gm) || []).sort().join(',');
    results.push({
      ok: true,
      nodeId: origin.nodeId,
      host: origin.host,
      apiPort: origin.apiPort,
      unit: origin.unit,
      out: stdout.trim().split('\n').slice(-2).join(' | '),
      xrayPidUnchanged: beforePids === afterPids,
      beforePids,
      afterPids,
    });
    console.log(`OK ${origin.nodeId}`);
  } catch (err) {
    results.push({
      ok: false,
      nodeId: origin.nodeId,
      host: origin.host,
      error: String(err.message || err).slice(0, 500),
    });
    console.error(`FAIL ${origin.nodeId}: ${err.message}`);
  }
}

console.log(
  JSON.stringify(
    {
      ok: results.every((r) => r.ok && r.xrayPidUnchanged !== false),
      installed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
      results,
      skippedDockerRelays:
        'NL/DE/AM/GB/DE2/USA docker configs have no Stats API; enabling needs Xray restart — left untouched',
    },
    null,
    2
  )
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
