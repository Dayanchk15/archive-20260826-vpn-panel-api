#!/usr/bin/env node
/** Deploy the isolated FR2 Bunny WS origin. Existing FR2 services are untouched. */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const FR2 = process.env.FR2_HOST || 'root@185.209.230.46';
const PORT = Number(process.env.BUNNY_WS_PORT || 18090);
const WS_PATH = process.env.BUNNY_WS_PATH || '/bunny/fr2';

function run(command, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
    });
  });
}

await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', 'scripts/generate-fr2-bunny-ws-config.mjs', `${PANEL}:/tmp/generate-fr2-bunny-ws-config.mjs`]);
const generated = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', PANEL,
  `docker cp /tmp/generate-fr2-bunny-ws-config.mjs vpn-panel-api-vps:/tmp/generate-fr2-bunny-ws-config.mjs && docker exec -w /app -e BUNNY_WS_PORT=${PORT} -e BUNNY_WS_PATH='${WS_PATH}' vpn-panel-api-vps node /tmp/generate-fr2-bunny-ws-config.mjs && docker cp vpn-panel-api-vps:/data/files/fr2-bunny-ws.json /tmp/fr2-bunny-ws.json`]);

const work = join(tmpdir(), 'fr2-bunny-ws');
mkdirSync(work, { recursive: true });
const installer = join(work, 'install-fr2-bunny-ws.sh');
const generatedConfig = join(work, 'fr2-bunny-ws.json');
writeFileSync(installer, readFileSync(new URL('./install-fr2-bunny-ws.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n'));

await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', `${PANEL}:/tmp/fr2-bunny-ws.json`, generatedConfig]);
await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-i', KEY, generatedConfig, `${FR2}:/tmp/fr2-bunny-ws.json`]);
await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-i', KEY, installer, `${FR2}:/tmp/install-fr2-bunny-ws.sh`]);
const installed = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-i', KEY, FR2,
  `chmod +x /tmp/install-fr2-bunny-ws.sh && /tmp/install-fr2-bunny-ws.sh ${PORT}`]);

console.log(generated.stdout.trim());
console.log(installed.stdout.trim());
console.log(JSON.stringify({ ok: true, host: '185.209.230.46', port: PORT, path: WS_PATH }));
