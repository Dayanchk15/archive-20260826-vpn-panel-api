#!/usr/bin/env node
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const file = process.argv[2] || 'tmp-edge-clients.json';
const host = process.env.TAMPA_SSH || 'root@74.115.172.101';
const key = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';

execSync(`scp -i ${key} -o BatchMode=yes ${file} ${host}:/tmp/edge-clients.json`, { stdio: 'inherit' });

const remote = `set -e
python3 <<'PY'
import json, pathlib, re
clients = json.load(open('/tmp/edge-clients.json'))
p = pathlib.Path('/opt/glb-vps-edge/docker-compose.yml')
text = p.read_text()
line = "      VLESS_CLIENTS_JSON: " + repr(json.dumps(clients))
text = re.sub(r"      VLESS_CLIENTS_JSON:.*", line, text)
p.write_text(text)
print('clients', len(clients))
PY
cd /opt/glb-vps-edge
docker compose up -d --force-recreate
docker ps --format '{{.Names}} {{.Status}}' | grep glb
`;

execSync(`ssh -i ${key} -o BatchMode=yes ${host} bash -s`, { input: remote, stdio: 'inherit' });
const count = JSON.parse(readFileSync(file, 'utf8')).length;
console.log(JSON.stringify({ ok: true, clients: count }));
