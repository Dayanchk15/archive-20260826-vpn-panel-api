#!/usr/bin/env node
/**
 * Install hot-sync agents for Bunny XHTTP origins so new panel clients
 * are pulled every ~15s into FR1/FR2/Fornex/Tampa XHTTP inbounds.
 *
 *   node scripts/install-bunny-xhttp-hot-sync-all.mjs
 */
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'install-bunny-xhttp-hot-sync.sh'), 'utf8');
const TAMPA_SCRIPT = readFileSync(join(ROOT, 'scripts', 'install-tampa-bunny-xhttp-hot-sync.sh'), 'utf8');

const TARGETS = [
  {
    id: 'bunny-xhttp-fr1',
    host: '185.209.230.14',
    config: '/opt/vpn-fr1-bunny-xhttp2/config.json',
    unit: 'xray-fr1-bunny-xhttp2-pilot.service',
    inboundTag: 'fr1-bunny-xhttp-in',
    apiPort: 10097,
    agentPort: 19233,
    sourceDir: '/opt/vpn-standalone-sync-fr1-bunny-v2',
    xrayBin: '/opt/vpn-fr1-bunny-xhttp2/xray',
  },
  {
    id: 'bunny-xhttp-fr2',
    host: '185.209.230.46',
    config: '/opt/vpn-dayanch-bunny-xhttp/config.json',
    unit: 'xray-dayanch-bunny-xhttp.service',
    inboundTag: 'dayanch-bunny-xhttp-in',
    apiPort: 10098,
    agentPort: 19229,
    sourceDir: '/opt/vpn-standalone-sync-pilot-fr2-bunny',
    xrayBin: '/opt/vpn-dayanch-bunny-xhttp/xray-26.3.27',
  },
  {
    id: 'bunny-xhttp-fornex',
    host: '130.17.12.61',
    config: '/opt/vpn-dayanch-bunny-xhttp/config.json',
    unit: 'xray-dayanch-bunny-xhttp.service',
    inboundTag: 'dayanch-bunny-xhttp-in',
    apiPort: 10098,
    agentPort: 19229,
    sourceDir: '/opt/vpn-standalone-sync-pilot-fornex-xhttp',
    xrayBin: '/usr/local/bin/xray',
  },
  {
    id: 'bunny-xhttp-tampa',
    host: '74.115.172.101',
    mode: 'docker-tampa',
    agentPort: 19233,
    config: '/opt/vpn-dayanch-bunny-xhttp/config.json',
    inboundTag: 'dayanch-bunny-xhttp-in',
  },
];

function run(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout ${cmd}`));
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

async function ssh(host, remote, timeoutMs = 240000) {
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

async function scp(local, remote) {
  return run('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25', '-i', KEY, local, remote]);
}

const work = join(tmpdir(), `bunny-xhttp-hotsync-${Date.now()}`);
mkdirSync(work, { recursive: true });
const localSh = join(work, 'install-bunny-xhttp-hot-sync.sh');
writeFileSync(localSh, SCRIPT);

const results = [];
for (const t of TARGETS) {
  process.stdout.write(`[${t.id} ${t.host}] `);
  try {
    let stdout;
    if (t.mode === 'docker-tampa') {
      const tampaLocal = join(work, 'install-tampa-bunny-xhttp-hot-sync.sh');
      writeFileSync(tampaLocal, TAMPA_SCRIPT);
      await scp(tampaLocal, `root@${t.host}:/tmp/install-tampa-bunny-xhttp-hot-sync.sh`);
      ({ stdout } = await ssh(t.host, 'bash /tmp/install-tampa-bunny-xhttp-hot-sync.sh', 420000));
    } else {
    await scp(localSh, `root@${t.host}:/tmp/install-bunny-xhttp-hot-sync.sh`);
    const cmd = [
      `CONFIG='${t.config}'`,
      `UNIT='${t.unit}'`,
      `INBOUND_TAG='${t.inboundTag}'`,
      `API_PORT='${t.apiPort}'`,
      `AGENT_PORT='${t.agentPort}'`,
      `EDGE_ID='${t.id}'`,
      `SOURCE_DIR='${t.sourceDir}'`,
      `TARGET_DIR='/opt/vpn-standalone-sync-${t.id}'`,
      t.xrayBin ? `XRAY_BIN='${t.xrayBin}'` : '',
      'bash /tmp/install-bunny-xhttp-hot-sync.sh',
    ]
      .filter(Boolean)
      .join(' ');
    ({ stdout } = await ssh(t.host, cmd, 300000));
    }
    const line = stdout
      .trim()
      .split('\n')
      .filter((l) => l.includes('BUNNY_XHTTP_HOT_SYNC_OK') || l.includes('"ok": true') || l.includes('"clientCount"'))
      .slice(-3)
      .join(' | ');
    console.log(line || stdout.trim().split('\n').slice(-2).join(' | '));
    results.push({ id: t.id, ok: true, out: stdout.trim() });
  } catch (err) {
    console.log('FAIL');
    console.error('  ' + String(err.message).split(/\r?\n/).slice(0, 8).join('\n  '));
    results.push({ id: t.id, ok: false, error: err.message });
  }
}

// Verify counts vs panel
console.log('\n=== verify agent status ===');
for (const t of TARGETS) {
  try {
    const { stdout } = await ssh(
      t.host,
      `curl -fsS --max-time 5 http://127.0.0.1:${t.agentPort}/v1/status; echo; python3 -c "import json;c=json.load(open('${t.config}'));ib=next(i for i in c['inbounds'] if i.get('tag')=='${t.inboundTag}');print('config_clients',len(ib['settings']['clients']),'api',bool(json.load(open('${t.config}')).get('api')))"`
    );
    console.log(`[${t.id}]`, stdout.trim().replace(/\n/g, ' | ').slice(0, 300));
  } catch (err) {
    console.log(`[${t.id}] VERIFY_FAIL`, String(err.message).split(/\r?\n/)[0]);
  }
}

console.log('\n' + JSON.stringify({ ok: results.every((r) => r.ok), results: results.map((r) => ({ id: r.id, ok: r.ok, error: r.error?.slice?.(0, 200) })) }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
