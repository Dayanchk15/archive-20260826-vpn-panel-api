#!/usr/bin/env node
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const JUMP = 'root@194.127.179.178';
const PANEL = 'root@45.140.42.39';
const FR2 = 'root@185.209.230.46';
const DOMAIN = 'france2.levospeed.click';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    c.stdout.on('data', (x) => { o += x; });
    c.stderr.on('data', (x) => { e += x; });
    c.on('close', (code) => (code === 0 ? resolve({ stdout: o }) : reject(new Error(e || o))));
  });
}

await run('ssh', ['-J', JUMP, '-o', 'BatchMode=yes', PANEL,
  `docker exec vpn-panel-api-vps env XHTTP_DOMAIN=${DOMAIN} OUTPUT=/data/files/fr2-fastly-dual.json node /data/files/generate-fr2-fastly-dual-config.mjs`]);

const { stdout: json } = await run('ssh', ['-J', JUMP, '-o', 'BatchMode=yes', PANEL, 'cat /opt/vpn-panel/files/fr2-fastly-dual.json']);
const local = join(tmpdir(), 'fr2-fastly-dual.json');
writeFileSync(local, json);
await run('scp', ['-o', 'BatchMode=yes', '-i', KEY, local, `${FR2}:/opt/vpn-fr2-xhttp-pilot/config.json`]);

const out = await new Promise((resolve, reject) => {
  const c = spawn('ssh', ['-o', 'BatchMode=yes', '-i', KEY, FR2, 'bash', '-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let o = '', e = '';
  c.stdout.on('data', (x) => { o += x; });
  c.stderr.on('data', (x) => { e += x; });
  c.on('close', (code) => (code === 0 ? resolve(o) : reject(new Error(e || o))));
  c.stdin.write(`set -e
/usr/local/bin/xray run -test -config /opt/vpn-fr2-xhttp-pilot/config.json
systemctl restart xray-fr2-xhttp-pilot
ufw allow 18444/tcp 2>/dev/null || true
sleep 2
ss -tlnp | grep -E '18444|8443'
`);
  c.stdin.end();
});
console.log(out);

console.log(JSON.stringify({
  ok: true,
  fastlyOriginChange: {
    tls: 'NO',
    port: 18444,
    overrideHost: DOMAIN,
    note: 'Fastly terminates TLS, origin is plain HTTP xHTTP',
  },
  fastlyLink: `vless://7a1639d3-242e-4cd3-88a5-585c4615323d@${DOMAIN}:443?encryption=none&security=tls&type=xhttp&path=%2Fmedia%2Fv2%2Flibrary%2Fsync&host=${DOMAIN}&sni=${DOMAIN}&fp=chrome&alpn=h2&mode=packet-up#FR2-Fastly-v2`,
  directTlsLink: `vless://7a1639d3-242e-4cd3-88a5-585c4615323d@185.209.230.46:8443?encryption=none&security=tls&type=xhttp&path=%2Fmedia%2Fv2%2Flibrary%2Fsync&host=${DOMAIN}&sni=${DOMAIN}&fp=chrome&alpn=h2&mode=packet-up&allowInsecure=1#FR2-xHTTP-direct`,
  tcpFallback: `vless://7a1639d3-242e-4cd3-88a5-585c4615323d@185.209.230.46:18443?encryption=none&security=none&type=tcp#FR2-TCP-like-FR1`,
}, null, 2));
