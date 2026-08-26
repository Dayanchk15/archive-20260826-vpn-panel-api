#!/usr/bin/env node
/**
 * Xray config for FR1 SS pilot: VLESS WS on 127.0.0.1:18088 (local only).
 *   EDGE_PORT=18088 LISTEN=127.0.0.1 node generate-fr1-local-vless-config.mjs
 */
import { writeFileSync } from 'fs';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';
import { withBlockQuicRouting } from '/app/lib/xray-routing.js';

const port = Number(process.env.EDGE_PORT || 18088);
const listen = String(process.env.LISTEN || '127.0.0.1').trim();
const output = String(process.env.OUTPUT || '/tmp/fr1-local-vless-config.json').trim();
const clients = await buildEdgeClientList();

const config = withBlockQuicRouting({
  log: { loglevel: 'error' },
  inbounds: [
    {
      listen,
      port,
      protocol: 'vless',
      tag: 'vless-ws-local',
      settings: {
        clients: clients.map((c) => ({
          id: c.uuid,
          email: c.email || c.name || c.userId || c.uuid,
          level: 0,
        })),
        decryption: 'none',
      },
      streamSettings: {
        network: 'ws',
        wsSettings: { path: '/' },
      },
    },
  ],
  outbounds: [{ protocol: 'freedom', tag: 'direct' }],
});

writeFileSync(output, JSON.stringify(config, null, 2));
console.log(JSON.stringify({ ok: true, output, listen, port, clients: clients.length }));
