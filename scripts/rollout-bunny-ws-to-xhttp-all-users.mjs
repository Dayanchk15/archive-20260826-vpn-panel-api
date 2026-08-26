#!/usr/bin/env node
/**
 * Replace public Bunny VLESS WS TLS (bunny-az-*-pilot) with Dayanch's working
 * Bunny XHTTP lines for ALL users.
 *
 * Steps:
 *  1) Expand XHTTP origin client lists (FR1/FR2/Fornex/Tampa) to all active UUIDs
 *  2) Convert bunny-az-*-pilot panel records to XHTTP settings
 *  3) Refresh every user subscription file
 *
 * Usage (from Admin PC):
 *   node scripts/rollout-bunny-ws-to-xhttp-all-users.mjs          # dry-run
 *   node scripts/rollout-bunny-ws-to-xhttp-all-users.mjs --apply
 */
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const PANEL = process.env.PANEL_HOST || 'root@45.140.42.39';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const WS_TO_XHTTP = [
  {
    publicId: 'bunny-az-fr1-pilot',
    sourceId: 'bunny-xhttp-fr1-a-dayanch',
    origin: {
      host: '185.209.230.14',
      config: '/opt/vpn-fr1-bunny-xhttp2/config.json',
      unit: 'xray-fr1-bunny-xhttp2-pilot.service',
      xrayBin: '/opt/vpn-fr1-bunny-xhttp2/xray',
    },
  },
  {
    publicId: 'bunny-az-fr2-pilot',
    sourceId: 'bunny-xhttp-fr2-dayanch',
    origin: {
      host: '185.209.230.46',
      config: '/opt/vpn-dayanch-bunny-xhttp/config.json',
      unit: 'xray-dayanch-bunny-xhttp.service',
      xrayBin: '/opt/vpn-dayanch-bunny-xhttp/xray-26.3.27',
    },
  },
  {
    publicId: 'bunny-az-fornex-pilot',
    sourceId: 'bunny-xhttp-fornex-dayanch',
    origin: {
      host: '130.17.12.61',
      config: '/opt/vpn-dayanch-bunny-xhttp/config.json',
      unit: 'xray-dayanch-bunny-xhttp.service',
      xrayBin: '/usr/local/bin/xray',
    },
  },
  {
    publicId: 'bunny-az-tampa-pilot',
    sourceId: 'bunny-xhttp-tampa-dayanch',
    origin: {
      host: '74.115.172.101',
      config: '/opt/vpn-dayanch-bunny-xhttp/config.json',
      unit: 'xray-dayanch-bunny-xhttp.service',
      xrayBin: '', // autodetect on host
    },
  },
];

const work = join(tmpdir(), `bunny-xhttp-rollout-${Date.now()}`);
mkdirSync(work, { recursive: true });

function run(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout ${cmd} ${args.join(' ')}`));
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
      else reject(new Error((stderr || stdout || `exit ${code}`).trim()));
    });
    child.on('error', reject);
  });
}

async function ssh(host, remote, timeoutMs = 180000) {
  return run(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=25',
      '-o',
      'ServerAliveInterval=30',
      '-i',
      KEY,
      `root@${host}`,
      remote,
    ],
    timeoutMs
  );
}

async function scp(local, remoteSpec) {
  return run('scp', [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=25',
    '-i',
    KEY,
    local,
    remoteSpec,
  ]);
}

async function panelExec(script) {
  return run(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=25',
      '-o',
      'ServerAliveInterval=30',
      '-i',
      KEY,
      PANEL,
      script,
    ],
    600000
  );
}

const EXPORT_CLIENTS = `#!/usr/bin/env node
import { writeFileSync } from 'fs';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';
const clients = await buildEdgeClientList();
writeFileSync('/tmp/edge-clients-xhttp.json', JSON.stringify(clients));
console.log(JSON.stringify({ ok: true, count: clients.length }));
`;

const PANEL_APPLY = `#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getServerById,
  listUsers,
  upsertServer,
} from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { nowIso } from '/app/lib/dates.js';

const APPLY = process.argv.includes('--apply');
const MAP = ${JSON.stringify(
  WS_TO_XHTTP.map((x) => ({ publicId: x.publicId, sourceId: x.sourceId }))
)};

function decode(body) {
  const text = String(body || '');
  if (text.includes('vless://')) return text;
  try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return text; }
}

function bunnyLines(body) {
  return decode(body).split(/\\r?\\n/).filter((l) => l.startsWith('vless://')).filter((l) => {
    try {
      const u = new URL(l);
      const host = u.searchParams.get('host') || '';
      const sni = u.searchParams.get('sni') || '';
      return host.includes('b-cdn.net') || sni.includes('b-cdn.net') || /BN/i.test(decodeURIComponent(l.split('#')[1] || ''));
    } catch { return false; }
  }).map((l) => {
    const u = new URL(l);
    return {
      type: u.searchParams.get('type'),
      host: u.searchParams.get('host'),
      path: u.searchParams.get('path'),
      sni: u.searchParams.get('sni'),
      alpn: u.searchParams.get('alpn'),
      mode: u.searchParams.get('mode'),
      addr: u.hostname,
    };
  });
}

const timestamp = nowIso();
const backups = {};
const updated = [];

for (const row of MAP) {
  const [pub, src] = await Promise.all([getServerById(row.publicId), getServerById(row.sourceId)]);
  if (!pub) throw new Error('missing public ' + row.publicId);
  if (!src) throw new Error('missing source ' + row.sourceId);
  backups[row.publicId] = pub;
  const next = {
    ...pub,
    network: 'xhttp',
    host: src.host,
    sni: src.sni || src.host,
    path: src.path,
    addressIp: src.addressIp,
    addressIps: Array.isArray(src.addressIps) && src.addressIps.length ? src.addressIps : [src.addressIp].filter(Boolean),
    forceAddressIp: true,
    port: 443,
    alpn: src.alpn || 'h2',
    fingerprint: src.fingerprint || 'chrome',
    security: 'tls',
    xhttpMode: src.xhttpMode || 'auto',
    flow: '',
    rejectUdp443: src.rejectUdp443 !== false,
    finalMask: src.finalMask || null,
    fragmentation: null,
    originAddress: src.originAddress || pub.originAddress,
    originPort: src.originPort || null,
    bunnyPullZoneId: src.bunnyPullZoneId || pub.bunnyPullZoneId || 6176525,
    subscriptionEligible: true,
    subscriptionHidden: false,
    addToNewClients: true,
    newUsersOnly: false,
    standalonePilot: false,
    allowPinnedRelayOnly: true,
    enabled: true,
    updatedAt: timestamp,
  };
  // keep public naming / sort
  next.name = pub.name;
  next.country = pub.country;
  next.flag = pub.flag;
  next.sortOrder = pub.sortOrder;
  updated.push({ id: row.publicId, from: { network: pub.network, host: pub.host, path: pub.path }, to: { network: next.network, host: next.host, path: next.path, addressIp: next.addressIp } });
  if (APPLY) await upsertServer(row.publicId, next);
}

const users = (await listUsers(10000)).filter((u) => u.uuid);
let refreshed = 0;
const sampleChecks = [];

if (APPLY) {
  const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
  await mkdir(backupRoot, { recursive: true });
  const backupPath = path.join(backupRoot, \`bunny-ws-to-xhttp-\${timestamp.replace(/[:.]/g, '-')}.json\`);
  await writeFile(backupPath, JSON.stringify({ createdAt: timestamp, backups, updated }, null, 2));

  for (const user of users) {
    await upsertUserSubscriptionFile(user);
    refreshed += 1;
  }
}

// verify a few non-dayanch users
for (const user of users.filter((u) => u.id !== 'usr_bnjXUy4O1NZufeqW').slice(0, 3)) {
  const body = await buildUserSubscriptionBody(user);
  const lines = bunnyLines(body);
  const ws = lines.filter((l) => l.type === 'ws');
  const xhttp = lines.filter((l) => l.type === 'xhttp');
  sampleChecks.push({
    user: user.name || user.id,
    bunnyTotal: lines.length,
    ws: ws.length,
    xhttp: xhttp.length,
    paths: xhttp.map((l) => l.path),
    hosts: [...new Set(xhttp.map((l) => l.host))],
  });
}

console.log(JSON.stringify({
  ok: sampleChecks.every((s) => s.ws === 0 && s.xhttp >= 4),
  dryRun: !APPLY,
  updated,
  refreshed,
  sampleChecks,
}, null, 2));
if (APPLY && !sampleChecks.every((s) => s.ws === 0 && s.xhttp >= 4)) process.exit(1);
`;

async function main() {
  console.log(APPLY ? 'MODE=apply' : 'MODE=dry-run');

  // 1) export clients from panel
  const exportLocal = join(work, 'export-clients.mjs');
  writeFileSync(exportLocal, EXPORT_CLIENTS);
  await scp(exportLocal, `${PANEL}:/opt/vpn-panel/files/export-clients-xhttp.mjs`);
  const { stdout: exportOut } = await panelExec(
    'docker cp /opt/vpn-panel/files/export-clients-xhttp.mjs vpn-panel-api-vps:/tmp/export-clients-xhttp.mjs && docker exec vpn-panel-api-vps node /tmp/export-clients-xhttp.mjs && docker cp vpn-panel-api-vps:/tmp/edge-clients-xhttp.json /opt/vpn-panel/files/edge-clients-xhttp.json'
  );
  console.log('clients', exportOut.trim());
  const clientsLocal = join(work, 'edge-clients-xhttp.json');
  await run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, `${PANEL}:/opt/vpn-panel/files/edge-clients-xhttp.json`, clientsLocal]);
  const clients = JSON.parse(readFileSync(clientsLocal, 'utf8'));
  console.log('loaded clients', clients.length);

  // 2) expand origins
  const expandSh = readFileSync(join(ROOT, 'scripts', 'expand-xhttp-origin-clients.sh'), 'utf8');
  const expandLocal = join(work, 'expand-xhttp-origin-clients.sh');
  writeFileSync(expandLocal, expandSh);

  const seenOrigins = new Set();
  for (const row of WS_TO_XHTTP) {
    const key = `${row.origin.host}:${row.origin.config}`;
    if (seenOrigins.has(key)) {
      console.log(`skip duplicate origin expand ${row.publicId}`);
      continue;
    }
    seenOrigins.add(key);
    console.log(`\n[origin ${row.origin.host}] expand for ${row.publicId}`);
    if (!APPLY) {
      const { stdout } = await ssh(
        row.origin.host,
        `python3 -c "import json;c=json.load(open('${row.origin.config}'));ib=next(i for i in c['inbounds'] if i.get('protocol')=='vless');print('current_clients',len(ib['settings']['clients']),'path',ib['streamSettings']['xhttpSettings']['path'],'unit', '$(systemctl is-active ${row.origin.unit})')"`
      );
      console.log(stdout.trim());
      continue;
    }
    await scp(expandLocal, `root@${row.origin.host}:/tmp/expand-xhttp-origin-clients.sh`);
    await scp(clientsLocal, `root@${row.origin.host}:/tmp/edge-clients-xhttp.json`);
    const binEnv = row.origin.xrayBin ? `XRAY_BIN='${row.origin.xrayBin}' ` : '';
    const { stdout } = await ssh(
      row.origin.host,
      `CONFIG='${row.origin.config}' UNIT='${row.origin.unit}' CLIENTS_JSON=/tmp/edge-clients-xhttp.json ${binEnv}bash /tmp/expand-xhttp-origin-clients.sh`
    );
    console.log(stdout.trim());
  }

  // 3) panel convert + refresh
  const panelLocal = join(work, 'panel-bunny-ws-to-xhttp.mjs');
  writeFileSync(panelLocal, PANEL_APPLY);
  await scp(panelLocal, `${PANEL}:/opt/vpn-panel/files/panel-bunny-ws-to-xhttp.mjs`);
  const applyFlag = APPLY ? '--apply' : '';
  const { stdout: panelOut } = await panelExec(
    `docker cp /opt/vpn-panel/files/panel-bunny-ws-to-xhttp.mjs vpn-panel-api-vps:/tmp/panel-bunny-ws-to-xhttp.mjs && docker exec vpn-panel-api-vps node /tmp/panel-bunny-ws-to-xhttp.mjs ${applyFlag}`
  );
  console.log(panelOut);

  if (!APPLY) {
    console.log('\nDry-run complete. Re-run with --apply to expand origins + convert subs.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
