#!/usr/bin/env node
/**
 * Regenerate and deploy FR2 xHTTP config for Fastly origin (france2.levospeed.click).
 */
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const JUMP = process.env.JUMP_HOST || 'root@194.127.179.178';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const FR2 = 'root@185.209.230.46';
const DOMAIN = process.env.XHTTP_DOMAIN || 'france2.levospeed.click';
const PORT = Number(process.env.XHTTP_PORT || 8443);
const PATH_XHTTP = process.env.XHTTP_PATH || '/media/v2/library/sync';

function run(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout: ${cmd}`));
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

async function panelExec(script) {
  return run('ssh', ['-J', JUMP, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', PANEL, script]);
}

async function sshBash(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, FR2, 'bash', '-s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    child.stdin.write(script);
    child.stdin.end();
  });
}

console.log('Generating FR2 Fastly xHTTP config...');
await panelExec(
  `docker exec vpn-panel-api-vps env XHTTP_PORT=${PORT} XHTTP_DOMAIN=${DOMAIN} XHTTP_PATH='${PATH_XHTTP}' OUTPUT=/data/files/fr2-xhttp-pilot.json node /data/files/generate-fr2-xhttp-pilot-config.mjs`
);

const { stdout: configJson } = await panelExec('cat /opt/vpn-panel/files/fr2-xhttp-pilot.json');
const work = join(tmpdir(), 'fr2-fastly');
mkdirSync(work, { recursive: true });
const configLocal = join(work, 'fr2-xhttp-pilot.json');
const installLocal = join(work, 'install-fr2-fastly-origin.sh');
writeFileSync(configLocal, configJson);
writeFileSync(
  installLocal,
  readFileSync(new URL('./install-fr2-fastly-origin.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
);

await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, configLocal, `${FR2}:/tmp/fr2-xhttp-pilot.json`]);
await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, installLocal, `${FR2}:/tmp/install-fr2-fastly-origin.sh`]);

console.log('Installing on FR2...');
const { stdout: installOut } = await sshBash(`set -e
sed -i 's/\\r$//' /tmp/install-fr2-fastly-origin.sh
chmod +x /tmp/install-fr2-fastly-origin.sh
/tmp/install-fr2-fastly-origin.sh ${PORT} ${DOMAIN}
curl -skI --resolve ${DOMAIN}:8443:127.0.0.1 https://${DOMAIN}:8443${PATH_XHTTP}/ 2>/dev/null | head -3 || true
`);
console.log(installOut.trim());

const meta = JSON.parse(
  (await panelExec('docker exec vpn-panel-api-vps node /data/files/build-fr2-xhttp-test-link.mjs')).stdout.trim()
    .replace(/^.*?\{/, '{')
);
// rebuild link for fastly domain on 443
const link = `vless://${meta.uuid}@${DOMAIN}:443?encryption=none&security=tls&type=xhttp&path=${encodeURIComponent(PATH_XHTTP)}&host=${encodeURIComponent(DOMAIN)}&sni=${encodeURIComponent(DOMAIN)}&fp=chrome&alpn=h3&mode=auto#FR2-Fastly`;

console.log(
  JSON.stringify(
    {
      ok: true,
      fr2: { ip: '185.209.230.46', pilotPort: PORT, productionPort: 8089, untouched: true },
      fastly: {
        domain: DOMAIN,
        originPort: PORT,
        originTls: 'self-signed (Fastly: enable TLS to origin + Do not verify)',
        overrideHost: DOMAIN,
        cache: 'Pass for ' + PATH_XHTTP,
      },
      testLink: link,
      fastlyOriginSettings: {
        host: '185.209.230.46',
        port: PORT,
        useTls: true,
        tlsVerify: false,
        overrideHost: DOMAIN,
      },
    },
    null,
    2
  )
);
