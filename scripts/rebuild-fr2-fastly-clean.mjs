#!/usr/bin/env node
/**
 * Remove both FR2 test Xray pilots and install one clean Fastly xHTTP origin.
 * The production relay at /opt/vpn-relay-edge (:8089) is verified and preserved.
 */
import { spawn } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const JUMP = process.env.JUMP_HOST || 'root@194.127.179.178';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const FR2 = process.env.FR2_HOST || 'root@185.209.230.46';
const DOMAIN = process.env.XHTTP_DOMAIN || 'france2.levospeed.click';
const ORIGIN_PORT = Number(process.env.FASTLY_ORIGIN_PORT || 18444);
const XHTTP_PATH = process.env.XHTTP_PATH || '/';

function run(command, args, { input = '', timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
    });

    child.stdin.end(input);
  });
}

function panelExec(script, timeoutMs = 180000) {
  return run(
    'ssh',
    ['-J', JUMP, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', PANEL, script],
    { timeoutMs }
  );
}

function fr2Bash(script, timeoutMs = 180000) {
  return run(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=25',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-i',
      KEY,
      FR2,
      'bash',
      '-s',
    ],
    { input: script, timeoutMs }
  );
}

const workDir = join(tmpdir(), 'fr2-fastly-clean');
mkdirSync(workDir, { recursive: true });
const sourceFile = join(workDir, 'source.json');
const serverFile = join(workDir, 'server.json');
const clientFile = join(workDir, 'client.json');

console.log('Generating a fresh client list from the panel...');
await panelExec(
  `docker exec vpn-panel-api-vps env FASTLY_PLAIN_PORT=${ORIGIN_PORT} XHTTP_PORT=8443 XHTTP_DOMAIN=${DOMAIN} XHTTP_PATH='${XHTTP_PATH}' OUTPUT=/data/files/fr2-fastly-clean-source.json node /data/files/generate-fr2-fastly-dual-config.mjs`
);
await run('scp', [
  '-J',
  JUMP,
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=25',
  `${PANEL}:/opt/vpn-panel/files/fr2-fastly-clean-source.json`,
  sourceFile,
]);

const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
const originInbound = source.inbounds.find((inbound) => Number(inbound.port) === ORIGIN_PORT);
if (!originInbound) throw new Error(`generated config has no inbound on ${ORIGIN_PORT}`);
if (!originInbound.settings?.clients?.length) throw new Error('generated config has no clients');

const xhttp = originInbound.streamSettings?.xhttpSettings;
if (!xhttp) throw new Error('generated config has no xHTTP settings');
xhttp.path = XHTTP_PATH;
xhttp.host = DOMAIN;
xhttp.mode = 'packet-up';
xhttp.noGRPCHeader = false;
xhttp.noSSEHeader = false;
xhttp.xPaddingBytes = '100-1000';

source.log = {
  access: '/var/log/vpn-fr2-fastly-access.log',
  error: '/var/log/vpn-fr2-fastly-error.log',
  loglevel: 'warning',
};
source.inbounds = [originInbound];
writeFileSync(serverFile, JSON.stringify(source, null, 2));

const testUuid = originInbound.settings.clients[0].id;
const clientConfig = {
  log: { loglevel: 'warning' },
  inbounds: [
    {
      listen: '127.0.0.1',
      port: 10809,
      protocol: 'socks',
      settings: { udp: false },
    },
  ],
  outbounds: [
    {
      tag: 'fr2-fastly-test',
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: DOMAIN,
            port: 443,
            users: [{ id: testUuid, encryption: 'none' }],
          },
        ],
      },
      streamSettings: {
        network: 'xhttp',
        security: 'tls',
        tlsSettings: {
          serverName: DOMAIN,
          fingerprint: 'chrome',
          alpn: ['h2'],
        },
        xhttpSettings: {
          path: XHTTP_PATH,
          host: DOMAIN,
          mode: 'packet-up',
          noGRPCHeader: false,
          noSSEHeader: false,
          xPaddingBytes: '100-1000',
        },
      },
    },
  ],
};
writeFileSync(clientFile, JSON.stringify(clientConfig, null, 2));

console.log(`Uploading clean config with ${originInbound.settings.clients.length} clients...`);
await run('scp', [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=25',
  '-i',
  KEY,
  serverFile,
  clientFile,
  `${FR2}:/tmp/`,
]);

console.log('Removing both test pilots and installing one Fastly origin...');
const { stdout: installOutput } = await fr2Bash(
  `set -euo pipefail
PRODUCTION_CONFIG=/opt/vpn-relay-edge/config.json
PRODUCTION_PID_BEFORE="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$' || true)"

if [ -z "$PRODUCTION_PID_BEFORE" ] || [ ! -f "$PRODUCTION_CONFIG" ]; then
  echo "Production relay validation failed; refusing cleanup" >&2
  exit 1
fi

systemctl disable --now xray-fr2-tcp-pilot.service xray-fr2-xhttp-pilot.service 2>/dev/null || true
systemctl stop xray-fr2-fastly.service 2>/dev/null || true
rm -f /etc/systemd/system/xray-fr2-tcp-pilot.service
rm -f /etc/systemd/system/xray-fr2-xhttp-pilot.service
rm -rf /opt/vpn-fr2-tcp-pilot
rm -rf /opt/vpn-fr2-xhttp-pilot
rm -f /var/log/vpn-fr2-tcp-pilot.log
rm -f /var/log/vpn-fr2-xhttp-pilot.log

install -d -m 755 /opt/vpn-fr2-fastly
install -m 600 /tmp/server.json /opt/vpn-fr2-fastly/config.json
/usr/local/bin/xray run -test -config /opt/vpn-fr2-fastly/config.json

cat > /etc/systemd/system/xray-fr2-fastly.service <<'UNIT'
[Unit]
Description=FR2 VLESS xHTTP origin for Fastly
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/xray run -c /opt/vpn-fr2-fastly/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable xray-fr2-fastly.service
systemctl restart xray-fr2-fastly.service
sleep 2
systemctl is-active --quiet xray-fr2-fastly.service

ufw delete allow 8443/tcp >/dev/null 2>&1 || true
ufw delete allow 18443/tcp >/dev/null 2>&1 || true
ufw allow ${ORIGIN_PORT}/tcp >/dev/null 2>&1 || true
while iptables -C INPUT -p tcp --dport 8443 -j ACCEPT 2>/dev/null; do
  iptables -D INPUT -p tcp --dport 8443 -j ACCEPT
done
while iptables -C INPUT -p tcp --dport 18443 -j ACCEPT 2>/dev/null; do
  iptables -D INPUT -p tcp --dport 18443 -j ACCEPT
done
iptables -C INPUT -p tcp --dport ${ORIGIN_PORT} -j ACCEPT 2>/dev/null ||
  iptables -I INPUT -p tcp --dport ${ORIGIN_PORT} -j ACCEPT

PRODUCTION_PID_AFTER="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$' || true)"
if [ "$PRODUCTION_PID_AFTER" != "$PRODUCTION_PID_BEFORE" ]; then
  echo "Production relay PID changed unexpectedly" >&2
  exit 1
fi

ss -ltnp | awk '$4 ~ /:8089$/ || $4 ~ /:${ORIGIN_PORT}$/ { print }'
if ss -ltnp | awk '$4 ~ /:8443$/ || $4 ~ /:18443$/ { found=1 } END { exit !found }'; then
  echo "An old pilot port is still listening" >&2
  exit 1
fi

echo "production_pid=$PRODUCTION_PID_AFTER"
echo "fastly_service=$(systemctl is-active xray-fr2-fastly.service)"
echo "old_tcp_service=$(systemctl is-enabled xray-fr2-tcp-pilot.service 2>/dev/null || true)"
echo "old_xhttp_service=$(systemctl is-enabled xray-fr2-xhttp-pilot.service 2>/dev/null || true)"
`,
  180000
);
console.log(installOutput.trim());

console.log('Testing the complete Fastly tunnel...');
const { stdout: testOutput } = await fr2Bash(
  `set -euo pipefail
cp /tmp/client.json /tmp/fr2-fastly-client.json
/usr/local/bin/xray run -test -config /tmp/fr2-fastly-client.json
/usr/local/bin/xray run -c /tmp/fr2-fastly-client.json >/tmp/fr2-fastly-client.log 2>&1 &
CLIENT_PID=$!
trap 'kill "$CLIENT_PID" 2>/dev/null || true; rm -f /tmp/fr2-fastly-client.json /tmp/server.json /tmp/client.json' EXIT
sleep 3
curl --silent --show-error --socks5-hostname 127.0.0.1:10809 --max-time 40 https://www.google.com/generate_204 -o /dev/null -w 'tunnel_http=%{http_code} tunnel_time=%{time_total}\\n'
`,
  90000
);
console.log(testOutput.trim());

const { stdout: publicOutput } = await run(
  'curl.exe',
  ['-sS', '-o', 'NUL', '-w', 'fastly_http=%{http_code} fastly_time=%{time_total}\\n', '--max-time', '20', `https://${DOMAIN}/`],
  { timeoutMs: 30000 }
);
console.log(publicOutput.trim());
console.log(
  JSON.stringify(
    {
      ok: true,
      production: { port: 8089, preserved: true },
      removedPilots: ['xray-fr2-tcp-pilot', 'xray-fr2-xhttp-pilot'],
      fastlyOrigin: {
        service: 'xray-fr2-fastly',
        host: '185.209.230.46',
        port: ORIGIN_PORT,
        tls: false,
        domain: DOMAIN,
        path: XHTTP_PATH,
        mode: 'packet-up',
        clients: originInbound.settings.clients.length,
      },
    },
    null,
    2
  )
);
