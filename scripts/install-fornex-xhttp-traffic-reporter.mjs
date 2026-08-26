#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const HOST = '130.17.12.61';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout ${cmd}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `exit ${code}`).trim()));
    });
    child.on('error', reject);
  });
}

function sshTarget(target, remote, timeoutMs = 120000) {
  return run('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=15',
    '-i', KEY,
    target,
    remote,
  ], timeoutMs);
}

function scp(local, remote, timeoutMs = 120000) {
  return run('scp', [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=20',
    '-i', KEY,
    local,
    remote,
  ], timeoutMs);
}

const { stdout: keyOut } = await sshTarget(
  PANEL,
  "grep -E '^EDGE_REPORT_KEY=' /opt/vpn-panel-api-vps/.env.vps | head -1 | cut -d= -f2-",
  60000
);
const reportKey = keyOut.trim();
if (!reportKey) throw new Error('EDGE_REPORT_KEY missing on panel');

const work = join(tmpdir(), `fornex-xhttp-reporter-${Date.now()}`);
mkdirSync(work, { recursive: true });
const envLocal = join(work, 'pilot-report.env');
const reporterLocal = join(work, 'standalone-traffic-reporter.py');
const installerLocal = join(work, 'install-live-stats-traffic-reporter.sh');
copyFileSync(join(ROOT, 'scripts', 'standalone-traffic-reporter.py'), reporterLocal);
copyFileSync(join(ROOT, 'scripts', 'install-standalone-traffic-reporter.sh'), installerLocal);
writeFileSync(envLocal, `PANEL_REPORT_URL=https://sub.twidu.com/internal/traffic/report\nEDGE_REPORT_KEY=${reportKey}\n`);

try {
  await scp(reporterLocal, `root@${HOST}:/tmp/standalone-traffic-reporter.py`);
  await scp(installerLocal, `root@${HOST}:/tmp/install-live-stats-traffic-reporter.sh`);
  await scp(envLocal, `root@${HOST}:/tmp/pilot-report.env`);

  const remote = [
    'set -euo pipefail',
    "sed -i 's/\\r$//' /tmp/install-live-stats-traffic-reporter.sh",
    'chmod 700 /tmp/install-live-stats-traffic-reporter.sh /tmp/standalone-traffic-reporter.py',
    'EDGE_DIR=/opt/vpn-dayanch-bunny-xhttp TRAFFIC_NODE_ID=fornex-dayanch-bunny-xhttp XRAY_API_PORT=10098 TRAFFIC_UNIT_NAME=xray-traffic-fornex-dayanch-bunny-xhttp XRAY_BIN=/usr/local/bin/xray bash /tmp/install-live-stats-traffic-reporter.sh',
    'systemctl is-active xray-traffic-fornex-dayanch-bunny-xhttp.service',
  ].join('; ');
  const { stdout } = await sshTarget(`root@${HOST}`, remote, 120000);
  console.log(JSON.stringify({
    ok: true,
    host: HOST,
    nodeId: 'fornex-dayanch-bunny-xhttp',
    apiPort: 10098,
    unit: 'xray-traffic-fornex-dayanch-bunny-xhttp.service',
    output: stdout.trim().split(/\r?\n/).filter(Boolean).slice(-3),
  }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
  await sshTarget(`root@${HOST}`, 'rm -f /tmp/pilot-report.env /tmp/standalone-traffic-reporter.py /tmp/install-live-stats-traffic-reporter.sh', 30000).catch(() => {});
}
