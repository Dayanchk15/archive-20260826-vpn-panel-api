#!/usr/bin/env node
/**
 * Deploy VLESS + WS + TLS edge on FR2 (direct-to-VPS, competitor-style).
 * Requires the A-record for WS_DOMAIN to already point at FR2 (185.209.230.46).
 * Production relay (:8089) and the Fastly origin (:18444) are left untouched.
 */
import { spawn } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const JUMP = process.env.JUMP_HOST || 'root@194.127.179.178';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const FR2 = process.env.FR2_HOST || 'root@185.209.230.46';
const DOMAIN = process.env.WS_DOMAIN || 'fr2direct.levospeed.click';
const PORT = Number(process.env.WS_PORT || 443);
const WS_PATH = process.env.WS_PATH || '/';

function run(command, args, { input = '', timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
    });
    child.stdin.end(input);
  });
}

const panelExec = (script, timeoutMs) =>
  run('ssh', ['-J', JUMP, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', PANEL, script], { timeoutMs });

const fr2Bash = (script, timeoutMs) =>
  run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', '-i', KEY, FR2, 'bash', '-s'], { input: script, timeoutMs });

const work = join(tmpdir(), 'fr2-ws-tls');
mkdirSync(work, { recursive: true });
const configLocal = join(work, 'config.json');
const installLocal = join(work, 'install.sh');

console.log('Generating WS+TLS config from active clients...');
await panelExec(
  `docker exec vpn-panel-api-vps env WS_PORT=${PORT} WS_DOMAIN=${DOMAIN} WS_PATH='${WS_PATH}' OUTPUT=/data/files/fr2-ws-tls.json node /data/files/generate-fr2-ws-tls-config.mjs`
);
await run('scp', ['-J', JUMP, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25',
  `${PANEL}:/opt/vpn-panel/files/fr2-ws-tls.json`, configLocal]);

const config = JSON.parse(readFileSync(configLocal, 'utf8'));
const inbound = config.inbounds.find((i) => Number(i.port) === PORT);
if (!inbound?.settings?.clients?.length) throw new Error('generated config has no clients on target port');
const testUuid = inbound.settings.clients[0].id;

writeFileSync(installLocal, readFileSync(new URL('./install-fr2-ws-tls.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n'));

console.log(`Uploading config (${inbound.settings.clients.length} clients) + installer...`);
await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY,
  configLocal, `${FR2}:/tmp/fr2-ws-tls.json`]);
await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY,
  installLocal, `${FR2}:/tmp/install-fr2-ws-tls.sh`]);

console.log('Installing WS+TLS edge (Let\'s Encrypt cert may take ~30s)...');
const { stdout: installOut } = await fr2Bash(
  `set -e
sed -i 's/\\r$//' /tmp/install-fr2-ws-tls.sh
chmod +x /tmp/install-fr2-ws-tls.sh
/tmp/install-fr2-ws-tls.sh ${DOMAIN} ${PORT}
`,
  240000
);
console.log(installOut.trim());

console.log('Testing tunnel end-to-end from FR2...');
const clientConfig = {
  log: { loglevel: 'warning' },
  inbounds: [{ listen: '127.0.0.1', port: 10870, protocol: 'socks', settings: { udp: true } }],
  outbounds: [{
    protocol: 'vless',
    settings: { vnext: [{ address: DOMAIN, port: PORT, users: [{ id: testUuid, encryption: 'none' }] }] },
    streamSettings: {
      network: 'ws',
      security: 'tls',
      tlsSettings: { serverName: DOMAIN, fingerprint: 'chrome', alpn: ['http/1.1'] },
      wsSettings: { path: WS_PATH, host: DOMAIN, headers: { Host: DOMAIN } },
    },
  }],
};
const clientLocal = join(work, 'client.json');
writeFileSync(clientLocal, JSON.stringify(clientConfig, null, 2));
await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, clientLocal, `${FR2}:/tmp/ws-client.json`]);
const { stdout: testOut } = await fr2Bash(
  `set -u
/usr/local/bin/xray run -c /tmp/ws-client.json >/tmp/ws-client.log 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true; rm -f /tmp/ws-client.json /tmp/ws-client.log' EXIT
sleep 3
curl -sS --socks5-hostname 127.0.0.1:10870 --max-time 25 https://www.google.com/generate_204 -o /dev/null -w 'ws_tunnel=%{http_code} time=%{time_total}\\n'
`,
  60000
);
console.log(testOut.trim());

const fragment = 'tlshello%2C3-3%2C0-1';
const link = `vless://${testUuid}@${DOMAIN}:${PORT}?encryption=none&security=tls&type=ws&path=${encodeURIComponent(WS_PATH)}&host=${encodeURIComponent(DOMAIN)}&sni=${encodeURIComponent(DOMAIN)}&fp=chrome&alpn=http%2F1.1&fragment=${fragment}#FR2-WS-Direct`;
console.log(JSON.stringify({
  ok: true,
  edge: { service: 'xray-fr2-ws-tls', host: '185.209.230.46', domain: DOMAIN, port: PORT, path: WS_PATH, clients: inbound.settings.clients.length },
  production: { port: 8089, preserved: true },
  testLink: link,
}, null, 2));
