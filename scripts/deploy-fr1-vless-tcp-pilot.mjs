#!/usr/bin/env node
/**
 * Deploy FR1 standalone VLESS TCP pilot for direct client testing.
 * Does NOT modify production relay on :8088 or gcp2-eu-fr1 subscription line.
 *
 * Run from Admin machine:
 *   node scripts/deploy-fr1-vless-tcp-pilot.mjs
 */
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const JUMP = process.env.JUMP_HOST || 'root@194.127.179.178';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const FR1 = process.env.FR1_HOST || 'root@185.209.230.14';
const PILOT_PORT = Number(process.env.FR1_TCP_PILOT_PORT || 18443);
const FR1_IP = '185.209.230.14';
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

async function fr1Exec(script) {
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, FR1, 'bash', '-s'], 180000).catch(
    async () => {
      return new Promise((resolve, reject) => {
        const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, FR1, 'bash', '-s'], {
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
        child.stdin.write(script);
        child.stdin.end();
      });
    }
  );
}

// 1. Generate config on panel
console.log('Generating FR1 TCP pilot config on panel...');
await panelExec(
  `docker exec vpn-panel-api-vps env EDGE_TCP_PORT=${PILOT_PORT} OUTPUT=/data/files/fr1-tcp-pilot.json node /data/files/generate-fr1-tcp-pilot-config.mjs`
);

const { stdout: configJson } = await panelExec('cat /opt/vpn-panel/files/fr1-tcp-pilot.json');
const work = join(tmpdir(), 'fr1-tcp-pilot');
mkdirSync(work, { recursive: true });
const configLocal = join(work, 'fr1-tcp-pilot.json');
const installLocal = join(work, 'install-fr1-tcp-pilot.sh');
writeFileSync(configLocal, configJson);
writeFileSync(
  installLocal,
  readFileSync(new URL('./install-fr1-tcp-pilot.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
);

// 2. Upload to FR1
console.log('Uploading to FR1...');
await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, configLocal, `${FR1}:/tmp/fr1-tcp-pilot.json`]);
await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, installLocal, `${FR1}:/tmp/install-fr1-tcp-pilot.sh`]);

// 3. Install on FR1
console.log('Installing pilot xray on FR1...');
const installScript = `set -e
sed -i 's/\\r$//' /tmp/install-fr1-tcp-pilot.sh
chmod +x /tmp/install-fr1-tcp-pilot.sh
/tmp/install-fr1-tcp-pilot.sh ${PILOT_PORT}
echo '--- production 8088 still running ---'
ss -tlnp | grep 8088 || true
`;
const { stdout: installOut } = await new Promise((resolve, reject) => {
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, FR1, 'bash', '-s'], {
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
  child.stdin.write(installScript);
  child.stdin.end();
});
console.log(installOut.trim());

// 4. Build test link
let testUserScript = `docker exec vpn-panel-api-vps node --input-type=module -e "
import { listUsers } from '/app/lib/db-store.js';
const users = await listUsers();
const u = users.find(x => x.id === '${TEST_USER_ID}') || users.find(x => x.status === 'active');
if (!u) { console.log(JSON.stringify({error:'no user'})); process.exit(1); }
const link = 'vless://' + u.uuid + '@${FR1_IP}:${PILOT_PORT}?encryption=none&security=none&type=tcp#' + encodeURIComponent('FR1 TCP pilot');
console.log(JSON.stringify({userId:u.id,name:u.name,uuid:u.uuid,link}));
"`;
const { stdout: userOut } = await panelExec(testUserScript);
const userInfo = JSON.parse(userOut.trim());

console.log('\n=== FR1 VLESS TCP PILOT READY ===');
console.log(JSON.stringify({
  ok: true,
  host: FR1_IP,
  port: PILOT_PORT,
  mode: 'vless-tcp-direct',
  productionUntouched: '185.209.230.14:8088 (relay)',
  systemd: 'xray-fr1-tcp-pilot',
  config: '/opt/vpn-fr1-tcp-pilot/config.json',
  log: '/var/log/vpn-fr1-tcp-pilot.log',
  testUser: { id: userInfo.userId, name: userInfo.name },
  testLink: userInfo.link,
  happManual: {
    protocol: 'vless',
    address: FR1_IP,
    port: PILOT_PORT,
    uuid: userInfo.uuid,
    network: 'tcp',
    security: 'none',
    encryption: 'none',
  },
}, null, 2));
