#!/usr/bin/env node
/**
 * Regenerate Xray edge configs with UDP/443 QUIC block and push to relay VPS.
 * Run from Admin machine (direct SSH to edges).
 *
 *   node scripts/apply-block-quic-all-edges.mjs
 *   DRY_RUN=1 node scripts/apply-block-quic-all-edges.mjs
 */
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RELAY_EU_EDGES, TAMPA_EDGE } from '../lib/relay-edge-registry.js';
import { buildEdgeClientList } from '../lib/edge-clients.js';
import { withBlockQuicRouting } from '../lib/xray-routing.js';

const DRY_RUN = ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN || '').toLowerCase());
const edges = [...RELAY_EU_EDGES, TAMPA_EDGE];

function buildEdgeConfig(port, clients) {
  return withBlockQuicRouting({
    log: { loglevel: 'error' },
    inbounds: [
      {
        listen: '0.0.0.0',
        port,
        protocol: 'vless',
        tag: 'vless-ws',
        settings: {
          clients: clients.map((c) => ({
            id: c.uuid,
            email: c.email || c.name || c.userId || c.uuid,
            level: 0,
          })),
          decryption: 'none',
        },
        streamSettings: { network: 'ws', wsSettings: { path: '/' } },
      },
    ],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  });
}

function sshRun(host, remoteScript, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', `root@${host}`, remoteScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout ${timeoutMs}ms`));
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

function scpFile(host, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', localPath, `root@${host}:${remotePath}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `scp exit ${code}`));
    });
    child.on('error', reject);
  });
}

const clients = await buildEdgeClientList();
const results = [];

for (const edge of edges) {
  const config = buildEdgeConfig(edge.edgePort, clients);
  const hasRule = config.routing?.rules?.some(
    (r) => r.network === 'udp' && String(r.port) === '443' && r.outboundTag === 'block',
  );
  const entry = { id: edge.id, ip: edge.ip, port: edge.edgePort, hasRule, ok: false };

  if (DRY_RUN) {
    entry.ok = true;
    entry.dryRun = true;
    results.push(entry);
    continue;
  }

  const localPath = join(tmpdir(), `edge-${edge.id}-config.json`);
  writeFileSync(localPath, JSON.stringify(config, null, 2));

  try {
    await scpFile(edge.ip, localPath, '/opt/vpn-relay-edge/config.json');
    await sshRun(
      edge.ip,
      `set -euo pipefail
/usr/local/bin/xray run -test -config /opt/vpn-relay-edge/config.json
pkill -f 'xray run' 2>/dev/null || true
sleep 1
nohup /usr/local/bin/xray run -c /opt/vpn-relay-edge/config.json >/var/log/vpn-relay-edge.log 2>&1 &
sleep 2
ss -tlnp | grep ':${edge.edgePort}\\b'`,
    );
    entry.ok = true;
  } catch (err) {
    entry.error = err.message;
  } finally {
    try {
      unlinkSync(localPath);
    } catch {
      // ignore
    }
  }

  results.push(entry);
}

console.log(JSON.stringify({ dryRun: DRY_RUN, clients: clients.length, results }, null, 2));
