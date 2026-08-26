#!/usr/bin/env node
/** Stop relay edge docker on a VPS (does not touch remnanode :443). */
import { execSync } from 'child_process';
import { EU_EDGES, sshHost, sshOpts } from './eu-relay-dayanch/config.mjs';

const edgeId = String(process.env.EDGE_ID || 'relay-eu-lv').trim();

const LEGACY_EDGES = {
  'relay-eu-lv': {
    id: 'relay-eu-lv',
    ip: '61.245.11.253',
    port: 8083,
    jump: true,
  },
};

const edge = EU_EDGES.find((e) => e.id === edgeId) || LEGACY_EDGES[edgeId];
if (!edge) throw new Error(`Unknown EDGE_ID=${edgeId}`);

const script = `set -e
if [ -d /opt/vpn-relay-edge ]; then
  cd /opt/vpn-relay-edge
  docker compose -f docker-compose.edge.yml down 2>/dev/null || true
  echo stopped
else
  echo no_edge_dir
fi
`;

execSync(`ssh -o BatchMode=yes ${sshOpts(edge)} ${sshHost(edge)} bash -s`, {
  input: script,
  stdio: 'inherit',
});

console.log(JSON.stringify({ ok: true, edgeId, ip: edge.ip }));
