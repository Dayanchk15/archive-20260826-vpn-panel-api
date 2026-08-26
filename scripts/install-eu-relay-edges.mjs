#!/usr/bin/env node
/**
 * Install EU relay Xray WS edges on 5 accessible Panel777 VPS.
 * Does NOT touch remnanode, :443, Tampa :8080, or Cloud Run 7-node pool.
 *
 *   node scripts/install-eu-relay-edges.mjs
 *   DRY_RUN=1 node scripts/install-eu-relay-edges.mjs
 */
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, cpSync, rmSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { buildEdgeClientList } from '../lib/edge-clients.js';
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
const ONLY_EDGE = String(process.env.ONLY_EDGE || '').trim();
const PANEL_REPORT_URL =
  process.env.PANEL_REPORT_URL || 'https://sub.twidu.com/internal/traffic/report';
const EDGE_REPORT_KEY = String(process.env.EDGE_REPORT_KEY || '').trim();

function run(cmd, opts = {}) {
  if (DRY_RUN) {
    console.log('[dry-run]', cmd.slice(0, 240));
    return '';
  }
  return execSync(cmd, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe', ...opts });
}

function scpToEdge(edge, localTar) {
  const remoteTar = `/tmp/vpn-relay-edge-${edge.id}.tar.gz`;
  const remote = `${sshHost(edge)}:${remoteTar}`;
  run(`scp -o BatchMode=yes ${scpOpts(edge)} "${localTar}" ${remote}`);
  return remoteTar;
}

function installOnEdge(edge, remoteTar, clientsJson) {
  const clientsEscaped = clientsJson.replace(/'/g, "'\\''");
  const script = `set -euo pipefail
EDGE_DIR=/opt/vpn-relay-edge
rm -rf "$EDGE_DIR"
mkdir -p "$EDGE_DIR"
tar -xzf ${remoteTar} -C "$EDGE_DIR"
chmod +x "$EDGE_DIR/install-edge-on-vps.sh"
export EDGE_PORT=${edge.port}
export VLESS_CLIENTS_JSON='${clientsEscaped}'
export PANEL_REPORT_URL='${PANEL_REPORT_URL.replace(/'/g, "'\\''")}'
export EDGE_REPORT_KEY='${EDGE_REPORT_KEY.replace(/'/g, "'\\''")}'
export TRAFFIC_NODE_ID='${edge.id}'
"$EDGE_DIR/install-edge-on-vps.sh"
ss -tlnp | grep -E ':${edge.port}\\b' || netstat -tlnp 2>/dev/null | grep -E ':${edge.port}\\b' || true
`;
  if (DRY_RUN) {
    console.log('[dry-run] ssh install', edge.id);
    return;
  }
  execSync(`ssh -o BatchMode=yes ${sshOpts(edge)} ${sshHost(edge)} bash -s`, {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

const edges = ONLY_EDGE ? EU_EDGES.filter((e) => e.id === ONLY_EDGE) : activeEuEdges();
if (!edges.length) throw new Error(`No edges matched ONLY_EDGE=${ONLY_EDGE}`);
if (!EDGE_REPORT_KEY && !DRY_RUN) {
  throw new Error('Set EDGE_REPORT_KEY (same as panel .env.vps) before installing relay edges');
}

const clientsJson =
  String(process.env.VLESS_CLIENTS_JSON || '').trim() ||
  (process.env.VLESS_CLIENTS_FILE
    ? readFileSync(process.env.VLESS_CLIENTS_FILE, 'utf8').trim()
    : '');
let clients;
if (clientsJson) {
  clients = JSON.parse(clientsJson);
} else {
  clients = await buildEdgeClientList();
}
const clientsSerialized = JSON.stringify(clients);
console.log(JSON.stringify({ step: 'edgeClients', count: clients.length }));

const tempDir = mkdtempSync(path.join(tmpdir(), 'eu-relay-edge-'));
const stageDir = path.join(tempDir, 'bundle');
const vpnEdgeSrc = path.join(root, 'vpn-edge');
if (!existsSync(vpnEdgeSrc)) throw new Error(`vpn-edge not found: ${vpnEdgeSrc}`);

cpSync(vpnEdgeSrc, path.join(stageDir, 'vpn-edge'), { recursive: true });
cpSync(path.join(edgeBundleDir, 'docker-compose.edge.yml'), path.join(stageDir, 'docker-compose.edge.yml'));
cpSync(path.join(edgeBundleDir, 'install-edge-on-vps.sh'), path.join(stageDir, 'install-edge-on-vps.sh'));

const archivePath = path.join(tempDir, 'bundle.tar.gz');
run(`tar -czf "${archivePath}" -C "${stageDir}" .`);

const results = [];
for (const edge of edges) {
  console.log(JSON.stringify({ step: 'installEdge', id: edge.id, ip: edge.ip, port: edge.port }));
  try {
    const remoteTar = scpToEdge(edge, archivePath);
    installOnEdge(edge, remoteTar, clientsSerialized);
    results.push({ id: edge.id, ok: true, port: edge.port, ip: edge.ip });
  } catch (err) {
    results.push({ id: edge.id, ok: false, error: err.message || String(err) });
  }
}

rmSync(tempDir, { recursive: true, force: true });
console.log(JSON.stringify({ ok: results.every((r) => r.ok), edges: results }, null, 2));
