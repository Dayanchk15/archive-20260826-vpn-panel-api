#!/usr/bin/env node
/**
 * Ensure docker EU edges use XRAY_EDGE_MODE=tcp before relay rollout restarts containers.
 */
import { spawn } from 'child_process';
import { activeEuEdges } from '/app/scripts/eu-relay-dayanch/config.mjs';

const DOCKER_EDGES = new Set(['relay-eu-nl', 'relay-eu-am', 'relay-eu-gb', 'relay-eu-de2']);

function sshRun(host, script, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', `root@${host}`, script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
    });
    child.on('error', reject);
  });
}

const remoteScript = `set -euo pipefail
cd /opt/vpn-relay-edge 2>/dev/null || cd /root/vpn-relay-edge 2>/dev/null || { echo NO_DIR; exit 1; }
COMPOSE=$(ls docker-compose*.yml 2>/dev/null | head -1)
[ -n "$COMPOSE" ] || { echo NO_COMPOSE; exit 1; }
if grep -q 'XRAY_EDGE_MODE' "$COMPOSE"; then
  sed -i 's/XRAY_EDGE_MODE:.*/XRAY_EDGE_MODE: tcp/' "$COMPOSE"
else
  sed -i '/environment:/a\\      XRAY_EDGE_MODE: tcp' "$COMPOSE"
fi
docker compose -f "$COMPOSE" up -d --force-recreate
sleep 6
C=$(docker ps --format '{{.Names}}' | grep vpn-relay-edge | head -1)
docker exec "$C" sh -c "ss -tlnp | grep ':8080\\b' || netstat -tlnp | grep ':8080\\b'"
docker exec "$C" sh -c "grep -E 'network|tcp' /etc/xray/config.json | head -3"
echo OK_TCP_DOCKER`;

const results = [];
for (const edge of activeEuEdges()) {
  if (!DOCKER_EDGES.has(edge.id)) continue;
  try {
    const out = await sshRun(edge.ip, remoteScript);
    results.push({ id: edge.id, ip: edge.ip, ok: true, out: out.split('\n').slice(-4).join(' | ') });
  } catch (err) {
    results.push({ id: edge.id, ip: edge.ip, ok: false, error: err.message });
  }
}

console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
