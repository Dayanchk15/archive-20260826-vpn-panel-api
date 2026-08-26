#!/usr/bin/env node
import { readFileSync } from 'fs';
import { spawn } from 'child_process';

const clientsFile = process.argv[2] || '/tmp/usa-clients.json';
const clientsJson = readFileSync(clientsFile, 'utf8');
const payload = Buffer.from(clientsJson, 'utf8').toString('base64');

const script = `set -euo pipefail
echo '${payload}' | base64 -d > /tmp/usa-clients.json
python3 <<'PY'
import json, pathlib, re
clients = json.load(open("/tmp/usa-clients.json"))
p = pathlib.Path("/opt/glb-vps-edge/docker-compose.yml")
text = p.read_text()
line = "      VLESS_CLIENTS_JSON: " + repr(json.dumps(clients))
text = re.sub(r"      VLESS_CLIENTS_JSON:.*", line, text)
p.write_text(text)
print("clients", len(clients))
PY
cd /opt/glb-vps-edge
docker compose up -d --force-recreate
echo OK_USA
`;

const out = await new Promise((resolve, reject) => {
  const child = spawn('ssh', ['-o', 'BatchMode=yes', 'root@74.115.172.101', 'bash', '-s'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString(); });
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  child.on('close', (code) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(stderr || stdout));
  });
  child.stdin.write(script);
  child.stdin.end();
});

console.log(out.trim());
