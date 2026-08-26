#!/usr/bin/env node
/**
 * Deploy FR2 standalone VLESS xHTTP + TLS pilot.
 * Does NOT modify production relay on :8089 or gcp2-eu-fr2 subscription line.
 *
 * Run from Admin machine:
 *   node scripts/deploy-fr2-vless-xhttp-pilot.mjs
 */
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const JUMP = process.env.JUMP_HOST || 'root@194.127.179.178';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const FR2 = process.env.FR2_HOST || 'root@185.209.230.46';
const FR2_IP = '185.209.230.46';
const PILOT_PORT = Number(process.env.FR2_XHTTP_PILOT_PORT || 8443);
const XHTTP_PATH = process.env.XHTTP_PATH || '/media/v2/library/sync';
const XHTTP_MODE = process.env.XHTTP_MODE || 'auto';
const TEST_USER_ID = process.env.TEST_USER_ID || '';

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

async function sshBash(host, script) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, host, 'bash', '-s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.on('data', () => {});
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

console.log('Generating FR2 xHTTP pilot config on panel...');
await panelExec(
  `docker exec vpn-panel-api-vps env XHTTP_PORT=${PILOT_PORT} FR2_IP=${FR2_IP} XHTTP_PATH='${XHTTP_PATH}' XHTTP_MODE='${XHTTP_MODE}' OUTPUT=/data/files/fr2-xhttp-pilot.json node /data/files/generate-fr2-xhttp-pilot-config.mjs`
);

const { stdout: configJson } = await panelExec('cat /opt/vpn-panel/files/fr2-xhttp-pilot.json');
const work = join(tmpdir(), 'fr2-xhttp-pilot');
mkdirSync(work, { recursive: true });
const configLocal = join(work, 'fr2-xhttp-pilot.json');
const installLocal = join(work, 'install-fr2-xhttp-pilot.sh');
writeFileSync(configLocal, configJson);
writeFileSync(
  installLocal,
  readFileSync(new URL('./install-fr2-xhttp-pilot.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
);

console.log('Uploading to FR2...');
await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, configLocal, `${FR2}:/tmp/fr2-xhttp-pilot.json`]);
await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, installLocal, `${FR2}:/tmp/install-fr2-xhttp-pilot.sh`]);

console.log('Installing pilot xray on FR2...');
const installScript = `set -e
sed -i 's/\\r$//' /tmp/install-fr2-xhttp-pilot.sh
chmod +x /tmp/install-fr2-xhttp-pilot.sh
/tmp/install-fr2-xhttp-pilot.sh ${PILOT_PORT} ${FR2_IP}
echo '--- production 8089 still running ---'
ss -tlnp | grep 8089 || true
`;
const { stdout: installOut } = await sshBash(FR2, installScript);
console.log(installOut.trim());

const testUserScript = `docker exec vpn-panel-api-vps node /data/files/build-fr2-xhttp-test-link.mjs ${TEST_USER_ID}`;
let userInfo;
try {
  const { stdout: userOut } = await panelExec(testUserScript);
  userInfo = JSON.parse(userOut.trim());
} catch {
  const encPath = encodeURIComponent(XHTTP_PATH);
  const encHost = encodeURIComponent(FR2_IP);
  const encSni = encodeURIComponent(FR2_IP);
  const fallbackScript = `docker exec vpn-panel-api-vps node --input-type=module -e "
import { listUsers } from '/app/lib/db-store.js';
const users = await listUsers();
const u = users.find(x => x.id === '${TEST_USER_ID}') || users.find(x => x.status === 'active');
if (!u) { console.log(JSON.stringify({error:'no user'})); process.exit(1); }
const link = 'vless://' + u.uuid + '@${FR2_IP}:${PILOT_PORT}?encryption=none&security=tls&type=xhttp&path=${encPath}&host=${encHost}&sni=${encSni}&fp=chrome&alpn=h2&mode=${XHTTP_MODE}#' + encodeURIComponent('FR2 xHTTP pilot');
console.log(JSON.stringify({userId:u.id,name:u.name,uuid:u.uuid,link}));
"`;
  const { stdout: userOut } = await panelExec(fallbackScript);
  userInfo = JSON.parse(userOut.trim());
}

console.log('\n=== FR2 VLESS xHTTP TLS PILOT READY ===');
console.log(
  JSON.stringify(
    {
      ok: true,
      host: FR2_IP,
      port: PILOT_PORT,
      mode: 'vless-xhttp-tls-direct',
      xhttpPath: XHTTP_PATH,
      xhttpMode: XHTTP_MODE,
      productionUntouched: `${FR2_IP}:8089 (relay)`,
      systemd: 'xray-fr2-xhttp-pilot',
      config: '/opt/vpn-fr2-xhttp-pilot/config.json',
      log: '/var/log/vpn-fr2-xhttp-pilot.log',
      tlsNote: 'Self-signed cert for IP — in Happ enable Allow Insecure OR pin SHA-256 if needed',
      testUser: { id: userInfo.userId, name: userInfo.name },
      testLink: userInfo.link,
      happManual: {
        protocol: 'vless',
        address: FR2_IP,
        port: PILOT_PORT,
        uuid: userInfo.uuid,
        network: 'xhttp',
        security: 'tls',
        path: XHTTP_PATH,
        host: FR2_IP,
        sni: FR2_IP,
        alpn: 'h2',
        fingerprint: 'chrome',
        mode: XHTTP_MODE,
        allowInsecure: true,
        xhttpExtra: {
          scMaxConcurrentPosts: 100,
          scMaxEachPostBytes: '1000000',
          scMinPostsIntervalMs: 30,
          xPaddingBytes: '100-1000',
        },
      },
    },
    null,
    2
  )
);
