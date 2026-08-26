#!/usr/bin/env node
/**
 * Apply FR2 dual-edge config (WS 8089 + SS2022 8443) on VPS.
 * Run from Admin machine with SSH to 185.209.230.46, or via panel if key works.
 */
import { readFileSync } from 'fs';
import { spawn } from 'child_process';

const VPS = process.env.FR2_VPS_HOST || '185.209.230.46';
const CONFIG = process.env.FR2_CONFIG || '/data/files/fr2-dual-edge-config.json';
const SS_PORT = 8443;

function run(cmd, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
    });
    child.on('error', reject);
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

const configBody = readFileSync(CONFIG, 'utf8');
const remoteScript = `set -euo pipefail
cat > /opt/vpn-relay-edge/config.json <<'EOF_CONFIG'
${configBody}
EOF_CONFIG
ufw allow ${SS_PORT}/tcp 2>/dev/null || true
/usr/local/bin/xray run -test -config /opt/vpn-relay-edge/config.json
pkill -f 'xray run' 2>/dev/null || true
sleep 1
nohup /usr/local/bin/xray run -c /opt/vpn-relay-edge/config.json >/var/log/vpn-relay-edge.log 2>&1 &
sleep 2
ss -tlnp | grep -E ':8089|:${SS_PORT}' || (echo 'ports missing' && exit 1)
echo OK_FR2_DUAL_EDGE
`;

console.log(JSON.stringify({ step: 'ssh_apply', vps: VPS }));
const result = await run('ssh', [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'ConnectTimeout=20',
  `root@${VPS}`,
  'bash',
  '-s',
], remoteScript);
console.log(result.stdout.trim());
