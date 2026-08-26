#!/usr/bin/env node
/**
 * Fix FR2 xHTTP for Fastly CDN: packet-up mode, no padding, redeploy.
 */
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const JUMP = process.env.JUMP_HOST || 'root@194.127.179.178';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const FR2 = 'root@185.209.230.46';
const DOMAIN = 'france2.levospeed.click';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
    });
  });
}

async function panelExec(script) {
  return run('ssh', ['-J', JUMP, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', PANEL, script]);
}

await panelExec(
  `docker exec vpn-panel-api-vps env XHTTP_PORT=8443 XHTTP_DOMAIN=${DOMAIN} XHTTP_MODE=packet-up OUTPUT=/data/files/fr2-xhttp-pilot.json node /data/files/generate-fr2-xhttp-pilot-config.mjs`
);

const { stdout: configJson } = await panelExec('cat /opt/vpn-panel/files/fr2-xhttp-pilot.json');
const work = join(tmpdir(), 'fr2-fix');
mkdirSync(work, { recursive: true });
const local = join(work, 'fr2-xhttp-pilot.json');
writeFileSync(local, configJson);

await run('scp', ['-o', 'BatchMode=yes', '-i', KEY, local, `${FR2}:/tmp/fr2-xhttp-pilot.json`]);

await new Promise((resolve, reject) => {
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-i', KEY, FR2, 'bash', '-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString(); });
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  child.on('close', (code) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(stderr || stdout));
  });
  child.stdin.write(`set -e
cp /tmp/fr2-xhttp-pilot.json /opt/vpn-fr2-xhttp-pilot/config.json
/usr/local/bin/xray run -test -config /opt/vpn-fr2-xhttp-pilot/config.json
systemctl restart xray-fr2-xhttp-pilot
sleep 2
systemctl is-active xray-fr2-xhttp-pilot
grep -E 'mode|xPadding|noSSE' /opt/vpn-fr2-xhttp-pilot/config.json
`);
  child.stdin.end();
}).then((out) => console.log(out));

const fastlyLink =
  `vless://7a1639d3-242e-4cd3-88a5-585c4615323d@${DOMAIN}:443?encryption=none&security=tls&type=xhttp&path=%2Fmedia%2Fv2%2Flibrary%2Fsync&host=${DOMAIN}&sni=${DOMAIN}&fp=chrome&alpn=h2&mode=packet-up#FR2-Fastly`;

const directLink =
  `vless://7a1639d3-242e-4cd3-88a5-585c4615323d@185.209.230.46:8443?encryption=none&security=tls&type=xhttp&path=%2Fmedia%2Fv2%2Flibrary%2Fsync&host=${DOMAIN}&sni=${DOMAIN}&fp=chrome&alpn=h2&mode=packet-up#FR2-direct`;

console.log(JSON.stringify({
  ok: true,
  changes: ['mode=packet-up', 'xPaddingBytes=0', 'noSSEHeader=true', 'alpn=h2 recommended'],
  fastlyLink,
  directLink,
  note: 'Try fastlyLink first. If still timeout, test directLink to isolate Fastly vs Xray',
}, null, 2));
