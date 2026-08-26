#!/usr/bin/env node
/**
 * Apply VLESS TCP on all 8 relay VPS edges from operator machine (Admin).
 * Panel container SSH keys are broken — run this locally with working ~/.ssh/id_ed25519.
 */
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const JUMP = process.env.JUMP_HOST || 'root@194.127.179.178';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';

const EDGES = [
  { id: 'nl', host: '194.127.178.70', port: 8081, listen: 8080, jump: true, docker: true },
  { id: 'de', host: '2.26.231.130', port: 8082, listen: 8080, jump: true, docker: true },
  { id: 'am', host: '194.127.179.178', port: 8083, listen: 8080, jump: false, docker: true },
  { id: 'gb', host: '185.169.234.182', port: 8084, listen: 8080, jump: true, docker: true },
  { id: 'de2', host: '45.133.251.146', port: 8085, listen: 8080, jump: false, docker: true },
  { id: 'fr1', host: '185.209.230.14', port: 8088, listen: 8088, jump: false, docker: false },
  { id: 'fr2', host: '185.209.230.46', port: 8089, listen: 8089, jump: false, docker: false },
  { id: 'usa', host: '74.115.172.101', port: 8080, listen: 8080, jump: false, docker: true, composeDir: '/opt/glb-vps-edge', containerMatch: 'glb-edge' },
];

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
  if (jump) {
    args.push('-o', `ProxyCommand=ssh -o BatchMode=yes -i ${KEY} -W %h:%p ${JUMP}`);
  }
  args.push(`root@${host}`);
  return args;
}

async function ssh(host, jump, script) {
  const args = sshArgs(host, jump);
  args.push(script);
  return run('ssh', args);
}

async function scp(local, host, jump, remote) {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=25',
    '-i',
    KEY,
  ];
  if (jump) {
    args.push('-o', `ProxyCommand=ssh -o BatchMode=yes -i ${KEY} -W %h:%p ${JUMP}`);
  }
  args.push(local, `root@${host}:${remote}`);
  return run('scp', args);
}

async function panelExec(script) {
  const args = ['-J', JUMP, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', PANEL, script];
  return run('ssh', args);
}

const work = join(tmpdir(), 'vps-tcp-configs');
mkdirSync(work, { recursive: true });

const configs = new Map();
for (const port of [...new Set(EDGES.map((e) => e.listen))]) {
  const out = `edge-tcp-${port}.json`;
  await panelExec(
    `docker exec vpn-panel-api-vps env EDGE_TCP_PORT=${port} OUTPUT=/data/files/${out} node /data/files/generate-edge-config-file.mjs`
  );
  const { stdout } = await panelExec(`cat /opt/vpn-panel/files/${out}`);
  const local = join(work, out);
  writeFileSync(local, stdout);
  configs.set(port, local);
  console.log(`generated ${out}`);
}

async function applyBare(edge, cfgPath) {
  await scp(cfgPath, edge.host, edge.jump, '/opt/vpn-relay-edge/config.json');
  const { stdout } = await ssh(
    edge.host,
    edge.jump,
    `set -euo pipefail
XRAY=$(command -v xray 2>/dev/null || true)
[ -x "$XRAY" ] || XRAY=/usr/local/bin/xray
[ -x "$XRAY" ] || { echo NO_XRAY; exit 1; }
"$XRAY" run -test -config /opt/vpn-relay-edge/config.json
pkill -f 'xray run' 2>/dev/null || true
sleep 1
nohup "$XRAY" run -c /opt/vpn-relay-edge/config.json >/var/log/vpn-relay-edge.log 2>&1 &
sleep 3
grep -E '"handshake"|"downlinkOnly"' /opt/vpn-relay-edge/config.json | head -2
ss -tlnp | grep ':${edge.listen}\\b' || (echo NO_LISTEN; tail -5 /var/log/vpn-relay-edge.log; exit 1)
echo OK_BARE`
  );
  return stdout.trim();
}

async function applyDocker(edge, cfgPath) {
  const edgeDir = edge.composeDir || '/opt/vpn-relay-edge';
  const containerMatch = edge.containerMatch || 'vpn-relay-edge';
  await scp(cfgPath, edge.host, edge.jump, `${edgeDir}/config.json`);
  const { stdout } = await ssh(
    edge.host,
    edge.jump,
    `set -euo pipefail
cd ${edgeDir}
COMPOSE=$(ls docker-compose*.yml 2>/dev/null | head -1)
if ! grep -q 'config.json:/etc/xray/config.json' "$COMPOSE"; then
  awk '/vpn-relay-edge:|vpn-glb-edge:/{print;print "    volumes:";print "      - ./config.json:/etc/xray/config.json:ro";next} {print}' "$COMPOSE" > "$COMPOSE.new"
  mv "$COMPOSE.new" "$COMPOSE"
fi
if grep -q '^    command:' "$COMPOSE"; then
  sed -i 's|^    command:.*|    command: ["xray", "run", "-c", "/etc/xray/config.json"]|' "$COMPOSE"
else
  awk '/vpn-relay-edge:|vpn-glb-edge:/{print;print "    command: [\\"xray\\", \\"run\\", \\"-c\\", \\"/etc/xray/config.json\\"]";next} {print}' "$COMPOSE" > "$COMPOSE.new"
  mv "$COMPOSE.new" "$COMPOSE"
fi
docker compose -f "$COMPOSE" up -d --force-recreate
sleep 10
C=$(docker ps --format '{{.Names}}' | grep ${containerMatch} | head -1)
docker exec "$C" grep -E '"handshake"|"downlinkOnly"' /etc/xray/config.json | head -2
docker exec "$C" sh -c 'netstat -tlnp 2>/dev/null | grep :8080 || ss -tlnp 2>/dev/null | grep :8080 || true'
ss -tlnp | grep ':${edge.port}\\b' || true
echo OK_DOCKER`
  );
  return stdout.trim();
}

const results = [];
for (const edge of EDGES) {
  const cfg = configs.get(edge.listen);
  try {
    const out = edge.docker ? await applyDocker(edge, cfg) : await applyBare(edge, cfg);
    results.push({ id: edge.id, ok: true, out: out.split('\n').slice(-2).join(' | ') });
    console.log(`OK ${edge.id}: ${results.at(-1).out}`);
  } catch (err) {
    results.push({ id: edge.id, ok: false, error: err.message });
    console.error(`FAIL ${edge.id}: ${err.message}`);
  }
}

console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
