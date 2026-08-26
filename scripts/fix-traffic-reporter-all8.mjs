#!/usr/bin/env node
/**
 * Restore online/offline display: start presence reporter on all 8 edges without Xray restart.
 */
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const JUMP = process.env.JUMP_HOST || 'root@194.127.179.178';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const REPORT_URL = process.env.PANEL_REPORT_URL || 'https://sub.twidu.com/internal/traffic/report';

const EDGES = [
  { id: 'nl', host: '194.127.178.70', jump: true, docker: true, nodeId: 'relay-eu-nl' },
  { id: 'de', host: '2.26.231.130', jump: true, docker: true, nodeId: 'relay-eu-de' },
  { id: 'am', host: '194.127.179.178', jump: false, docker: true, nodeId: 'relay-eu-am' },
  { id: 'gb', host: '185.169.234.182', jump: true, docker: true, nodeId: 'relay-eu-gb' },
  { id: 'de2', host: '45.133.251.146', jump: false, docker: true, nodeId: 'relay-eu-de2' },
  { id: 'fr1', host: '185.209.230.14', jump: false, docker: false, nodeId: 'relay-eu-fr1' },
  { id: 'fr2', host: '185.209.230.46', jump: false, docker: false, nodeId: 'relay-eu-fr2' },
  { id: 'usa', host: '74.115.172.101', jump: false, docker: true, nodeId: 'relay-usa', composeDir: '/opt/glb-vps-edge', containerMatch: 'glb-edge' },
];

const PRESENCE_SCRIPT = readFileSync(new URL('../vpn-edge/presence-from-logs.js', import.meta.url), 'utf8');

function run(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout: ${cmd} ${args.join(' ')}`));
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
  });
}

function sshArgs(host, jump) {
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=25', '-i', KEY];
  if (jump) args.push('-o', `ProxyCommand=ssh -o BatchMode=yes -i ${KEY} -W %h:%p ${JUMP}`);
  args.push(`root@${host}`);
  return args;
}

async function ssh(host, jump, script) {
  return run('ssh', [...sshArgs(host, jump), 'bash -s'], 180000, script);
}

// Fix ssh to pass script via stdin
async function sshBash(host, jump, script) {
  return new Promise((resolve, reject) => {
    const args = [...sshArgs(host, jump), 'bash', '-s'];
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('ssh timeout'));
    }, 180000);
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
    child.stdin.write(script);
    child.stdin.end();
  });
}

async function scp(local, host, jump, remote) {
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=25', '-i', KEY];
  if (jump) args.push('-o', `ProxyCommand=ssh -o BatchMode=yes -i ${KEY} -W %h:%p ${JUMP}`);
  args.push(local, `root@${host}:${remote}`);
  return run('scp', args);
}

async function panelExec(script) {
  return run('ssh', ['-J', JUMP, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', PANEL, script]);
}

const { stdout: reportKeyOut } = await panelExec(
  "grep -E '^EDGE_REPORT_KEY=' /opt/vpn-panel-api-vps/.env.vps 2>/dev/null | head -1 | cut -d= -f2-"
);
const reportKey = reportKeyOut.trim();
if (!reportKey) throw new Error('EDGE_REPORT_KEY not found on panel');
console.log('EDGE_REPORT_KEY loaded');

const work = join(tmpdir(), 'traffic-reporter-fix');
mkdirSync(work, { recursive: true });
const presenceLocal = join(work, 'presence-from-logs.js');
writeFileSync(presenceLocal, PRESENCE_SCRIPT);

function dockerRemoteScript(edge) {
  const edgeDir = edge.composeDir || '/opt/vpn-relay-edge';
  const containerMatch = edge.containerMatch || 'vpn-relay-edge';
  return `set -e
cd ${edgeDir}
grep -q '^PANEL_REPORT_URL=' .env 2>/dev/null && sed -i 's|^PANEL_REPORT_URL=.*|PANEL_REPORT_URL=${REPORT_URL}|' .env || echo PANEL_REPORT_URL=${REPORT_URL} >> .env
grep -q '^EDGE_REPORT_KEY=' .env 2>/dev/null && sed -i 's|^EDGE_REPORT_KEY=.*|EDGE_REPORT_KEY=${reportKey}|' .env || echo EDGE_REPORT_KEY=${reportKey} >> .env
grep -q '^TRAFFIC_NODE_ID=' .env 2>/dev/null && sed -i 's|^TRAFFIC_NODE_ID=.*|TRAFFIC_NODE_ID=${edge.nodeId}|' .env || echo TRAFFIC_NODE_ID=${edge.nodeId} >> .env
C=$(docker ps --format '{{.Names}}' | grep ${containerMatch} | head -1)
if [ -z "$C" ]; then echo NO_CONTAINER; exit 1; fi
docker cp /tmp/presence-from-logs.js "$C":/app/presence-from-logs.js
pkill -f "presence-from-logs.js" 2>/dev/null || true
sleep 1
nohup sh -c "docker logs -f --tail 0 $C 2>&1 | docker exec -i -e PANEL_REPORT_URL=${REPORT_URL} -e EDGE_REPORT_KEY=${reportKey} -e TRAFFIC_NODE_ID=${edge.nodeId} $C node /app/presence-from-logs.js" > /var/log/vpn-presence-${edge.id}.log 2>&1 &
sleep 2
ps aux | grep -E 'presence-from-logs|docker logs -f' | grep -v grep | head -2 || echo STARTED_BG
echo OK_DOCKER ${edge.id}
`;
}

function bareRemoteScript(edge) {
  return `set -e
mkdir -p /opt/vpn-relay-edge
cat > /opt/vpn-relay-edge/presence.env <<EOF
PANEL_REPORT_URL=${REPORT_URL}
EDGE_REPORT_KEY=${reportKey}
TRAFFIC_NODE_ID=${edge.nodeId}
EOF
cp /tmp/presence-from-logs.js /opt/vpn-relay-edge/presence-from-logs.js
pkill -f presence-from-logs.js 2>/dev/null || true
sleep 1
nohup sh -c 'set -a; . /opt/vpn-relay-edge/presence.env; set +a; tail -F /var/log/vpn-relay-edge.log 2>/dev/null | node /opt/vpn-relay-edge/presence-from-logs.js' > /var/log/vpn-presence-${edge.id}.log 2>&1 &
sleep 2
ps aux | grep presence-from-logs | grep -v grep | head -2 || echo STARTED_BG
echo OK_BARE ${edge.id}
`;
}

const results = [];
for (const edge of EDGES) {
  try {
    await scp(presenceLocal, edge.host, edge.jump, '/tmp/presence-from-logs.js');
    const script = edge.docker ? dockerRemoteScript(edge) : bareRemoteScript(edge);
    const { stdout } = await sshBash(edge.host, edge.jump, script);
    results.push({ id: edge.id, ok: true, out: stdout.trim().split('\n').slice(-3).join(' | ') });
    console.log(`OK ${edge.id}: ${results.at(-1).out}`);
  } catch (err) {
    results.push({ id: edge.id, ok: false, error: err.message });
    console.error(`FAIL ${edge.id}: ${err.message}`);
  }
}

console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
