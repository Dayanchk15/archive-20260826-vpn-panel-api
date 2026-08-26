#!/usr/bin/env node
/**
 * Configure real byte traffic reporting for all Tencent EdgeOne WS origins.
 *
 * This intentionally restarts only the four isolated TE Xray units, one by one,
 * after validating the patched config with `xray run -test`.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const SSH_KEY = process.env.SSH_KEY || '';
const REPORT_URL = process.env.PANEL_REPORT_URL || 'https://sub.twidu.com/internal/traffic/report';
const API_PORT = 10091;
const TARGET_EDGES = new Set(
  String(process.env.TARGET_EDGES || '')
    .split(/[\s,]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

const ALL_ORIGINS = [
  {
    host: '185.209.230.14',
    edgeId: 'fr1',
    config: '/opt/vpn-fr1-tencent-ws/config.json',
    edgeDir: '/opt/vpn-fr1-tencent-ws',
    inboundTag: 'fr1-tencent-ws-in',
    xrayUnit: 'xray-fr1-tencent-ws.service',
    trafficUnit: 'xray-traffic-fr1-tencent-ws',
    nodeId: 'fr1-tencent-ws',
  },
  {
    host: '185.209.230.46',
    edgeId: 'fr2',
    config: '/opt/vpn-fr2-tencent-ws/config.json',
    edgeDir: '/opt/vpn-fr2-tencent-ws',
    inboundTag: 'fr2-tencent-ws-in',
    xrayUnit: 'xray-fr2-tencent-ws.service',
    trafficUnit: 'xray-traffic-fr2-tencent-ws',
    nodeId: 'fr2-tencent-ws',
  },
  {
    host: '130.17.12.61',
    edgeId: 'fornex',
    config: '/opt/vpn-fornex-tencent-ws/config.json',
    edgeDir: '/opt/vpn-fornex-tencent-ws',
    inboundTag: 'fornex-tencent-ws-in',
    xrayUnit: 'xray-fornex-tencent-ws.service',
    trafficUnit: 'xray-traffic-fornex-tencent-ws',
    nodeId: 'fornex-tencent-ws',
  },
  {
    host: '74.115.172.101',
    edgeId: 'tampa',
    config: '/opt/vpn-tampa-tencent-ws/config.json',
    edgeDir: '/opt/vpn-tampa-tencent-ws',
    inboundTag: 'tampa-tencent-ws-in',
    xrayUnit: 'xray-tampa-tencent-ws.service',
    trafficUnit: 'xray-traffic-tampa-tencent-ws',
    nodeId: 'tampa-tencent-ws',
  },
];

const ORIGINS = TARGET_EDGES.size
  ? ALL_ORIGINS.filter((origin) => TARGET_EDGES.has(origin.edgeId))
  : ALL_ORIGINS;

if (!ORIGINS.length) {
  throw new Error(`TARGET_EDGES did not match any Tencent origin: ${[...TARGET_EDGES].join(',')}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout: ${cmd} ${args.join(' ')}`));
    }, opts.timeoutMs || 180000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `exit ${code}`).trim()));
    });
    child.on('error', reject);
  });
}

function sshArgs(target) {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=20',
    '-o',
    'ServerAliveInterval=15',
  ];
  if (SSH_KEY) args.push('-i', SSH_KEY);
  args.push(target);
  return args;
}

async function ssh(target, command, opts = {}) {
  return run('ssh', [...sshArgs(target), command], opts);
}

async function scp(local, target, remote, opts = {}) {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=20',
  ];
  if (SSH_KEY) args.push('-i', SSH_KEY);
  args.push(local, `${target}:${remote}`);
  return run('scp', args, opts);
}

const work = join(tmpdir(), `te-traffic-reporters-${Date.now()}`);
mkdirSync(work, { recursive: true });

const exportScript = join(work, 'export-te-clients-userids.mjs');
const clientsLocal = join(work, 'te-edge-clients-userids.json');
const reportEnv = join(work, 'pilot-report.env');
const patchScript = join(work, 'patch-tencent-xray-stats.py');
const reporterScript = join(work, 'standalone-traffic-reporter.py');
const reporterInstaller = join(work, 'install-live-stats-traffic-reporter.sh');

writeFileSync(
  exportScript,
  `import { writeFileSync } from 'node:fs';
import { listUsers } from '/app/lib/db-store.js';
import { isUserActive } from '/app/lib/active-users.js';
const users = await listUsers(10000);
const clients = users
  .filter(isUserActive)
  .map((user) => ({
    uuid: String(user.uuid || '').trim().toLowerCase(),
    userId: user.id,
    email: 'user-' + user.id,
    name: user.name || ''
  }))
  .filter((client) => client.uuid);
writeFileSync('/data/files/te-edge-clients-userids.json', JSON.stringify(clients, null, 2) + '\\n');
console.log(JSON.stringify({ ok: true, clients: clients.length }, null, 2));
`
);
copyFileSync(join(ROOT, 'scripts', 'patch-tencent-xray-stats.py'), patchScript);
copyFileSync(join(ROOT, 'scripts', 'standalone-traffic-reporter.py'), reporterScript);
copyFileSync(join(ROOT, 'scripts', 'install-live-stats-traffic-reporter.sh'), reporterInstaller);

try {
  await scp(exportScript, PANEL, '/opt/vpn-panel/files/export-te-clients-userids.mjs');
  const exportResult = await ssh(
    PANEL,
    'docker exec vpn-panel-api-vps node /data/files/export-te-clients-userids.mjs',
    { timeoutMs: 60000 }
  );
  const clientsMeta = JSON.parse(exportResult.stdout);
  if (!clientsMeta.ok || !clientsMeta.clients) {
    throw new Error(`client export failed: ${exportResult.stdout}`);
  }
  await run('scp', [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    `${PANEL.replace(/^root@/, 'root@')}:/opt/vpn-panel/files/te-edge-clients-userids.json`,
    clientsLocal,
  ]);
  const clients = JSON.parse(readFileSync(clientsLocal, 'utf8'));
  if (!Array.isArray(clients) || clients.length !== clientsMeta.clients) {
    throw new Error('downloaded client list mismatch');
  }

  const { stdout: keyOut } = await ssh(
    PANEL,
    "grep -E '^EDGE_REPORT_KEY=' /opt/vpn-panel-api-vps/.env.vps | head -1 | cut -d= -f2-"
  );
  const reportKey = keyOut.trim();
  if (!reportKey) throw new Error('EDGE_REPORT_KEY missing on panel');
  writeFileSync(reportEnv, `PANEL_REPORT_URL=${REPORT_URL}\nEDGE_REPORT_KEY=${reportKey}\n`);

  const results = [];
  for (const origin of ORIGINS) {
    const target = `root@${origin.host}`;
    await scp(patchScript, target, '/tmp/patch-tencent-xray-stats.py');
    await scp(clientsLocal, target, '/tmp/te-edge-clients-userids.json');
    await scp(reporterScript, target, '/tmp/standalone-traffic-reporter.py');
    await scp(reporterInstaller, target, '/tmp/install-live-stats-traffic-reporter.sh');
    await scp(reportEnv, target, '/tmp/pilot-report.env');
    await ssh(
      target,
      "sed -i 's/\\r$//' /tmp/patch-tencent-xray-stats.py /tmp/install-live-stats-traffic-reporter.sh /tmp/standalone-traffic-reporter.py && chmod 700 /tmp/patch-tencent-xray-stats.py /tmp/install-live-stats-traffic-reporter.sh /tmp/standalone-traffic-reporter.py"
    );

    const patchCmd = [
      'set -e',
      `python3 /tmp/patch-tencent-xray-stats.py '${origin.config}' /tmp/te-edge-clients-userids.json '${origin.inboundTag}' ${API_PORT}`,
      `systemctl restart '${origin.xrayUnit}'`,
      'sleep 2',
      `systemctl is-active --quiet '${origin.xrayUnit}'`,
      // A freshly restarted Xray legitimately returns an empty stats query
      // until the first client transfers bytes. Config validation plus an
      // active unit is the correct zero-traffic readiness check here.
      `test -s '${origin.config}'`,
    ].join('; ');
    const patchOut = await ssh(target, patchCmd, { timeoutMs: 90000 });

    const installCmd = [
      'set -e',
      `export EDGE_DIR='${origin.edgeDir}'`,
      `export TRAFFIC_NODE_ID='${origin.nodeId}'`,
      `export XRAY_API_PORT='${API_PORT}'`,
      `export TRAFFIC_UNIT_NAME='${origin.trafficUnit}'`,
      'export REPORT_ENV=/tmp/pilot-report.env',
      'export XRAY_BIN=/usr/local/bin/xray',
      'bash /tmp/install-live-stats-traffic-reporter.sh',
      `systemctl is-active --quiet '${origin.trafficUnit}'`,
      `systemctl --no-pager --full status '${origin.trafficUnit}' | sed -n '1,8p'`,
    ].join('; ');
    const installOut = await ssh(target, installCmd, { timeoutMs: 90000 });

    results.push({
      ok: true,
      nodeId: origin.nodeId,
      host: origin.host,
      xrayUnit: origin.xrayUnit,
      trafficUnit: origin.trafficUnit,
      clients: clients.length,
      patch: patchOut.stdout.trim().split(/\r?\n/).slice(-8).join(' | '),
      install: installOut.stdout.trim().split(/\r?\n/).slice(-8).join(' | '),
    });
    console.log(`OK ${origin.nodeId}`);
  }

  await ssh(
    PANEL,
    'rm -f /opt/vpn-panel/files/export-te-clients-userids.mjs /opt/vpn-panel/files/te-edge-clients-userids.json'
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        clients: clients.length,
        origins: results.length,
        results,
      },
      null,
      2
    )
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
