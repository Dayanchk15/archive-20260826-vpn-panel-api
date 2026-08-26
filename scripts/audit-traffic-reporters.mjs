#!/usr/bin/env node
/**
 * Safe inventory: which edges already expose Xray Stats API and whether
 * a real byte reporter (not presence-only) is running.
 * Does NOT restart Xray or change VPN configs.
 */
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const JUMP = process.env.JUMP_HOST || 'root@194.127.179.178';

const TARGETS = [
  // Canonical 8 relay edges
  { id: 'relay-eu-nl', host: '194.127.178.70', jump: true, docker: true, containerMatch: 'vpn-relay-edge', apiPorts: [10085], nodeId: 'relay-eu-nl' },
  { id: 'relay-eu-de', host: '2.26.231.130', jump: true, docker: true, containerMatch: 'vpn-relay-edge', apiPorts: [10085], nodeId: 'relay-eu-de' },
  { id: 'relay-eu-am', host: '194.127.179.178', jump: false, docker: true, containerMatch: 'vpn-relay-edge', apiPorts: [10085], nodeId: 'relay-eu-am' },
  { id: 'relay-eu-gb', host: '185.169.234.182', jump: true, docker: true, containerMatch: 'vpn-relay-edge', apiPorts: [10085], nodeId: 'relay-eu-gb' },
  { id: 'relay-eu-de2', host: '45.133.251.146', jump: false, docker: true, containerMatch: 'vpn-relay-edge', apiPorts: [10085], nodeId: 'relay-eu-de2' },
  { id: 'relay-eu-fr1', host: '185.209.230.14', jump: false, docker: false, apiPorts: [10085, 10086, 10089, 10090, 10091, 10092, 10093, 10094], nodeId: 'relay-eu-fr1', xrayBin: '/usr/local/bin/xray' },
  { id: 'relay-eu-fr2', host: '185.209.230.46', jump: false, docker: false, apiPorts: [10085, 10086, 10089, 10090, 10091, 10092, 10093, 10094], nodeId: 'relay-eu-fr2', xrayBin: '/usr/local/bin/xray' },
  { id: 'relay-usa', host: '74.115.172.101', jump: false, docker: true, containerMatch: 'glb-edge', apiPorts: [10085, 10086], nodeId: 'relay-usa', composeDir: '/opt/glb-vps-edge' },
  // Standalone pilots / CDN origins often colocated
  { id: 'tampa-host', host: '74.115.172.101', jump: false, docker: false, apiPorts: [10085, 10086, 10089, 10090, 10091, 10092, 10093, 10094], nodeId: 'tampa-host', xrayBin: '/usr/local/bin/xray', extraProbe: true },
  { id: 'fornex-host', host: '130.17.12.61', jump: false, docker: false, apiPorts: [10085, 10086, 10089, 10090, 10091, 10092, 10093, 10094], nodeId: 'fornex-host', xrayBin: '/usr/local/bin/xray', extraProbe: true },
];

function sshArgs(host, jump) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=15',
    '-i', KEY,
  ];
  if (jump) args.push('-o', `ProxyCommand=ssh -o BatchMode=yes -i ${KEY} -W %h:%p ${JUMP}`);
  args.push(`root@${host}`);
  return args;
}

function sshBash(host, jump, script) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshArgs(host, jump), 'bash', '-s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('ssh timeout'));
    }, 120000);
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
    child.stdin.write(script);
    child.stdin.end();
  });
}

function probeScript(target) {
  const ports = target.apiPorts.join(' ');
  const bin = target.xrayBin || 'xray';
  const docker = target.docker ? '1' : '0';
  const match = target.containerMatch || '';
  return `set +e
echo TARGET ${target.id}
echo PROCESSES
pgrep -af 'xray|traffic-reporter|presence-from-logs' 2>/dev/null | head -40
echo LISTENERS
ss -lntp 2>/dev/null | awk '/1008[0-9]|1009[0-9]/ {print}'
echo REPORTERS
systemctl list-units --type=service --all --no-pager 2>/dev/null | awk 'tolower($0) ~ /traffic|presence/ {print}'
ps aux 2>/dev/null | awk 'tolower($0) ~ /traffic-reporter|presence-from-logs/ && $0 !~ /awk/ {print}'
echo DOCKER_ENV
if [ "${docker}" = "1" ]; then
  C=$(docker ps --format '{{.Names}}' 2>/dev/null | grep '${match}' | head -1)
  echo CONTAINER=\${C:-none}
  if [ -n "\$C" ]; then
    docker exec "\$C" sh -c 'echo PANEL_REPORT_URL=\$PANEL_REPORT_URL; echo TRAFFIC_NODE_ID=\$TRAFFIC_NODE_ID; echo XRAY_API_PORT=\$XRAY_API_PORT; pgrep -af traffic-reporter || true' 2>/dev/null
  fi
fi
echo STATS
for port in ${ports}; do
  if [ "${docker}" = "1" ]; then
    C=$(docker ps --format '{{.Names}}' 2>/dev/null | grep '${match}' | head -1)
    if [ -n "\$C" ]; then
      OUT=$(docker exec "\$C" sh -c "xray api statsquery --server=127.0.0.1:\$port -pattern traffic 2>/dev/null | head -c 400" 2>/dev/null)
      RC=\$?
      if [ \$RC -eq 0 ] && [ -n "\$OUT" ]; then
        COUNT=$(printf '%s' "\$OUT" | grep -o 'user>>>' | wc -l | tr -d ' ')
        echo PORT_OK \$port users=\$COUNT sample=\$(printf '%s' "\$OUT" | tr '\\n' ' ' | head -c 180)
      else
        echo PORT_FAIL \$port
      fi
    fi
  else
    if [ -x "${bin}" ]; then
      OUT=$("${bin}" api statsquery --server=127.0.0.1:\$port -pattern traffic 2>/dev/null | head -c 400)
      RC=\$?
      if [ \$RC -eq 0 ] && [ -n "\$OUT" ]; then
        COUNT=$(printf '%s' "\$OUT" | grep -o 'user>>>' | wc -l | tr -d ' ')
        echo PORT_OK \$port users=\$COUNT sample=\$(printf '%s' "\$OUT" | tr '\\n' ' ' | head -c 180)
      else
        echo PORT_FAIL \$port
      fi
    else
      echo NO_XRAY_BIN
    fi
  fi
done
echo CONFIG_HINTS
python3 - <<'PY'
import glob, json, os
paths=[]
for pattern in ['/opt/**/config.json','/usr/local/etc/xray/*.json']:
  paths.extend(glob.glob(pattern, recursive=True))
seen=set()
for p in paths:
  if p in seen: continue
  seen.add(p)
  try:
    c=json.load(open(p))
  except Exception:
    continue
  api=c.get('api')
  stats='stats' in c
  policy=(((c.get('policy') or {}).get('levels') or {}).get('0') or {})
  api_ports=[]
  for i in c.get('inbounds',[]):
    if i.get('tag')=='api' or i.get('protocol')=='dokodemo-door':
      api_ports.append((i.get('listen'), i.get('port'), i.get('tag')))
  public=[]
  for i in c.get('inbounds',[]):
    tag=i.get('tag')
    port=i.get('port')
    if tag and tag!='api' and port:
      clients=len((i.get('settings') or {}).get('clients') or [])
      public.append((tag, port, clients))
  if api or stats or api_ports or public:
    print(json.dumps({'path':p,'stats':stats,'api':api,'statsUserUplink':policy.get('statsUserUplink'),'apiPorts':api_ports,'public':public[:8]}, ensure_ascii=False))
PY
echo END
`;
}

const results = [];
for (const target of TARGETS) {
  process.stdout.write(`Probing ${target.id}...\n`);
  try {
    const { stdout } = await sshBash(target.host, target.jump, probeScript(target));
    const portOk = [...stdout.matchAll(/PORT_OK (\d+) users=(\d+)/g)].map((m) => ({
      port: Number(m[1]),
      users: Number(m[2]),
    }));
    const hasTrafficReporter =
      /traffic-reporter\.(js|py)/i.test(stdout) ||
      /vpn-.*traffic/i.test(stdout) ||
      /standalone-traffic/i.test(stdout);
    const hasPresence = /presence-from-logs/i.test(stdout);
    results.push({
      id: target.id,
      host: target.host,
      nodeId: target.nodeId,
      ok: true,
      statsPorts: portOk,
      statsReady: portOk.length > 0,
      hasTrafficReporter,
      hasPresence,
      rawTail: stdout.split('\n').slice(0, 80).join('\n'),
    });
  } catch (err) {
    results.push({
      id: target.id,
      host: target.host,
      ok: false,
      error: String(err.message || err).slice(0, 400),
    });
  }
}

const outDir = join(tmpdir(), 'traffic-audit');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'traffic-audit.json');
const summary = {
  ok: true,
  readyForReporterOnly: results
    .filter((r) => r.statsReady)
    .map((r) => ({
      id: r.id,
      host: r.host,
      nodeId: r.nodeId,
      ports: r.statsPorts,
      hasTrafficReporter: r.hasTrafficReporter,
      hasPresence: r.hasPresence,
    })),
  needsConfigFix: results
    .filter((r) => r.ok && !r.statsReady)
    .map((r) => ({ id: r.id, host: r.host, hasPresence: r.hasPresence })),
  failedSsh: results.filter((r) => !r.ok),
  results,
};
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  readyForReporterOnly: summary.readyForReporterOnly,
  needsConfigFix: summary.needsConfigFix,
  failedSsh: summary.failedSsh,
  saved: outPath,
}, null, 2));
