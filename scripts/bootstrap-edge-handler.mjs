#!/usr/bin/env node
/**
 * Rolling bootstrap: deploy vpn-edge bundle with HandlerService API on one relay edge.
 * Restarts the Xray container once (brief disconnect on that edge only).
 *
 *   node scripts/bootstrap-edge-handler.mjs
 *   ONLY_EDGE=relay-eu-am node scripts/bootstrap-edge-handler.mjs
 *   DRY_RUN=1 node scripts/bootstrap-edge-handler.mjs
 */
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, cpSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  EU_EDGES,
  activeEuEdges,
  scpOpts,
  sshHost,
  sshOpts,
} from './eu-relay-dayanch/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const edgeBundleDir = path.join(__dirname, 'eu-relay-dayanch');
const DRY_RUN = process.env.DRY_RUN === '1';
const ONLY_EDGE = String(process.env.ONLY_EDGE || process.env.PILOT_EDGE || 'relay-eu-am').trim();
const PAUSE_MS = Math.max(0, Number(process.env.EDGE_BOOTSTRAP_PAUSE_MS || 15000));

function run(cmd, opts = {}) {
  if (DRY_RUN) {
    console.log('[dry-run]', cmd.slice(0, 240));
    return '';
  }
  return execSync(cmd, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe', ...opts });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scpToEdge(edge, localTar) {
  const remoteTar = `/tmp/vpn-relay-edge-handler-${edge.id}.tar.gz`;
  const remote = `${sshHost(edge)}:${remoteTar}`;
  run(`scp -o BatchMode=yes ${scpOpts(edge)} "${localTar}" ${remote}`);
  return remoteTar;
}

function bootstrapOnEdge(edge, remoteTar) {
  const script = `set -euo pipefail
EDGE_DIR=/opt/vpn-relay-edge
mkdir -p "$EDGE_DIR"
tar -xzf ${remoteTar} -C "$EDGE_DIR"
cd "$EDGE_DIR"
if [ -f docker-compose.edge.yml ]; then
  COMPOSE_FILE=docker-compose.edge.yml
else
  COMPOSE_FILE=docker-compose.yml
fi
docker compose -f "$COMPOSE_FILE" build --no-cache vpn-relay-edge 2>/dev/null || docker compose -f "$COMPOSE_FILE" build vpn-relay-edge
docker compose -f "$COMPOSE_FILE" up -d --force-recreate vpn-relay-edge
sleep 3
docker compose -f "$COMPOSE_FILE" exec -T vpn-relay-edge node /app/vpn-edge/generate-xray-config.js 2>/dev/null || true
xray api inbounduser -s 127.0.0.1:10085 -tag vless-ws >/dev/null 2>&1 && echo handler_ok || echo handler_check_failed
ss -tlnp | grep -E ':${edge.port}\\b' || netstat -tlnp 2>/dev/null | grep -E ':${edge.port}\\b' || true
`;
  if (DRY_RUN) {
    console.log('[dry-run] ssh bootstrap', edge.id);
    return;
  }
  execSync(`ssh -o BatchMode=yes ${sshOpts(edge)} ${sshHost(edge)} bash -s`, {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

const edges = ONLY_EDGE ? EU_EDGES.filter((e) => e.id === ONLY_EDGE) : activeEuEdges();
if (!edges.length) throw new Error(`No edges matched ONLY_EDGE=${ONLY_EDGE}`);

const tempDir = mkdtempSync(path.join(tmpdir(), 'edge-handler-bootstrap-'));
const stageDir = path.join(tempDir, 'bundle');
const vpnEdgeSrc = path.join(root, 'vpn-edge');
if (!existsSync(vpnEdgeSrc)) throw new Error(`vpn-edge not found: ${vpnEdgeSrc}`);

cpSync(vpnEdgeSrc, path.join(stageDir, 'vpn-edge'), { recursive: true });
cpSync(path.join(edgeBundleDir, 'docker-compose.edge.yml'), path.join(stageDir, 'docker-compose.edge.yml'));

const archivePath = path.join(tempDir, 'bundle.tar.gz');
run(`tar -czf "${archivePath}" -C "${stageDir}" .`);

const results = [];
for (let i = 0; i < edges.length; i += 1) {
  const edge = edges[i];
  console.log(JSON.stringify({ step: 'bootstrap', edgeId: edge.id, ip: edge.ip, port: edge.port }));
  const remoteTar = scpToEdge(edge, archivePath);
  bootstrapOnEdge(edge, remoteTar);
  results.push({ edgeId: edge.id, ok: true });
  if (i < edges.length - 1 && PAUSE_MS > 0) await sleep(PAUSE_MS);
}

rmSync(tempDir, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, edges: results }, null, 2));
