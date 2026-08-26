#!/usr/bin/env node
/** Sync Tampa (USA) edge docker with all 56 clients. FR1/others untouched. */
import { buildEdgeClientList } from '/app/lib/edge-clients.js';
import { spawn } from 'child_process';
import { existsSync } from 'fs';

const clients = await buildEdgeClientList();
const clientsJson = JSON.stringify(clients);
const payload = Buffer.from(clientsJson, 'utf8').toString('base64');

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

const script = `set -euo pipefail
python3 <<'PY'
import base64, json, pathlib, re
clients = json.loads(base64.b64decode("${payload}").decode())
p = pathlib.Path("/opt/glb-vps-edge/docker-compose.yml")
text = p.read_text()
line = "      VLESS_CLIENTS_JSON: " + repr(json.dumps(clients))
text = re.sub(r"      VLESS_CLIENTS_JSON:.*", line, text)
p.write_text(text)
print("clients", len(clients))
PY
cd /opt/glb-vps-edge
docker compose up -d --force-recreate
echo OK_USA_EDGE
`;

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `exit ${code}`));
    });
    child.on('error', reject);
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

const key = resolveSshKey();
const out = await run(
  'ssh',
  ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', key, 'root@74.115.172.101', 'bash', '-s'],
  script
);
console.log(JSON.stringify({ ok: out.includes('OK_USA_EDGE'), clients: clients.length, output: out.trim() }));
