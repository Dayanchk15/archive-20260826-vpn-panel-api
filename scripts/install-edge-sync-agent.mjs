#!/usr/bin/env node
/**
 * SSH install vpn-edge-sync-agent on a relay VPS edge (pilot: relay-eu-am).
 *
 *   EDGE_SYNC_KEY=... node scripts/install-edge-sync-agent.mjs
 *   ONLY_EDGE=relay-eu-am PANEL_PULL_URL=https://sub.example.com/internal/edge/clients node scripts/install-edge-sync-agent.mjs
 *   DRY_RUN=1 node scripts/install-edge-sync-agent.mjs
 */
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, cpSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  EU_EDGES,
  scpOpts,
  sshHost,
  sshOpts,
} from './eu-relay-dayanch/config.mjs';

const TAMPA_EDGE = {
  id: 'glb-vps-1',
  ip: '74.115.172.101',
  jump: false,
  sshPort: 22,
  port: 8080,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const agentDir = path.join(root, 'vpn-edge-sync-agent');
const DRY_RUN = process.env.DRY_RUN === '1';
const SKIP_UPLOAD = process.env.SKIP_UPLOAD === '1';
const ONLY_EDGE = String(process.env.ONLY_EDGE || process.env.PILOT_EDGE || 'relay-eu-am').trim();
const SYNC_KEY = String(process.env.EDGE_SYNC_KEY || process.env.EDGE_REPORT_KEY || '').trim();
const PANEL_PULL_URL = String(
  process.env.PANEL_PULL_URL || 'https://sub.twidu.com/internal/edge/clients'
).trim();
const AGENT_PORT = Number(process.env.AGENT_PORT || 19222);

if (!SYNC_KEY && !DRY_RUN) {
  throw new Error('Set EDGE_SYNC_KEY (same as panel .env) before installing agent');
}

const ALL_EDGES = [...EU_EDGES, TAMPA_EDGE];
const edges = ALL_EDGES.filter((e) => e.id === ONLY_EDGE);
if (!edges.length) throw new Error(`Edge not found: ${ONLY_EDGE}`);

function run(cmd, opts = {}) {
  if (DRY_RUN) {
    console.log('[dry-run]', cmd.slice(0, 240));
    return '';
  }
  return execSync(cmd, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe', ...opts });
}

function waitMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function scpToEdge(edge, localTar) {
  const remoteTar = `/tmp/vpn-edge-sync-agent-${edge.id}.tar.gz`;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      run(`scp -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=5 ${scpOpts(edge)} "${localTar}" ${sshHost(edge)}:${remoteTar}`);
      return remoteTar;
    } catch (err) {
      lastError = err;
      console.error(`SCP attempt ${attempt}/3 failed for ${edge.id}`);
      if (attempt < 3) waitMs(3000 * attempt);
    }
  }
  throw lastError || new Error(`SCP failed for ${edge.id}`);
}

function installAgent(edge, remoteTar) {
  const syncKeyEscaped = SYNC_KEY.replace(/'/g, "'\\''");
  const pullUrlEscaped = PANEL_PULL_URL.replace(/'/g, "'\\''");
const script = `set -euo pipefail
XRAY_PID_BEFORE="$(pgrep -o xray || true)"
DEPLOY_DIR=/opt/vpn-relay-edge-sync
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"
tar -xzf ${remoteTar} -C "$DEPLOY_DIR"
cd "$DEPLOY_DIR/vpn-edge-sync-agent"
cat > .env <<ENV
EDGE_ID=${edge.id}
EDGE_SYNC_KEY=${syncKeyEscaped}
PANEL_PULL_URL=${pullUrlEscaped}
PANEL_PULL_INTERVAL_MS=${process.env.PANEL_PULL_INTERVAL_MS || 15000}
AGENT_PORT=${AGENT_PORT}
ENV
docker compose -f docker-compose.agent.yml --env-file .env up -d --build --no-deps vpn-edge-sync-agent
sleep 2
curl -fsS "http://127.0.0.1:${AGENT_PORT}/health"
curl -fsS -H 'x-edge-sync-key: ${syncKeyEscaped}' "http://127.0.0.1:${AGENT_PORT}/v1/maintenance" >/dev/null
XRAY_PID_AFTER="$(pgrep -o xray || true)"
if [ -n "$XRAY_PID_BEFORE" ] && [ "$XRAY_PID_BEFORE" != "$XRAY_PID_AFTER" ]; then
  echo "SAFETY_FAILURE: Xray PID changed during agent-only rollout" >&2
  exit 1
fi
`;
  if (DRY_RUN) {
    console.log('[dry-run] ssh install agent', edge.id);
    return;
  }
  execSync(`ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 ${sshOpts(edge)} ${sshHost(edge)} bash -s`, {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

if (!existsSync(path.join(agentDir, 'server.mjs'))) {
  throw new Error(`vpn-edge-sync-agent not found: ${agentDir}`);
}

const tempDir = mkdtempSync(path.join(tmpdir(), 'edge-sync-agent-'));
const bundleRoot = path.join(tempDir, 'deploy');
cpSync(agentDir, path.join(bundleRoot, 'vpn-edge-sync-agent'), { recursive: true });
cpSync(path.join(root, 'vpn-edge', 'xray-client-diff.js'), path.join(bundleRoot, 'vpn-edge', 'xray-client-diff.js'));
cpSync(path.join(root, 'vpn-edge', 'proto'), path.join(bundleRoot, 'vpn-edge', 'proto'), {
  recursive: true,
});

const archivePath = path.join(tempDir, 'agent.tar.gz');
run(`tar -czf "${archivePath}" -C "${bundleRoot}" .`);

const results = [];
for (const edge of edges) {
  console.log(JSON.stringify({ step: 'installAgent', edgeId: edge.id, ip: edge.ip }));
  const remoteTar = SKIP_UPLOAD
    ? `/tmp/vpn-edge-sync-agent-${edge.id}.tar.gz`
    : scpToEdge(edge, archivePath);
  installAgent(edge, remoteTar);
  results.push({ edgeId: edge.id, ok: true, agentPort: AGENT_PORT });
}

rmSync(tempDir, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, edges: results, panelPullUrl: PANEL_PULL_URL }, null, 2));
