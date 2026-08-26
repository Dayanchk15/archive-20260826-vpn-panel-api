#!/usr/bin/env node
/**
 * Generate standalone VLESS TCP pilot config for FR1 (direct client connect, no relay).
 * Usage: EDGE_TCP_PORT=18443 OUTPUT=/data/files/fr1-tcp-pilot.json node ...
 */
import { writeFileSync } from 'fs';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';
import { buildVlessTcpEdgeConfig } from '/app/lib/xray-tcp-edge-config.js';

const tcpPort = Number(process.env.EDGE_TCP_PORT || 18443);
const output = String(process.env.OUTPUT || '/data/files/fr1-tcp-pilot.json').trim();
const clients = await buildEdgeClientList();

const config = buildVlessTcpEdgeConfig({
  clients,
  tcpPort,
  includeHandlerApi: true,
  logLevel: 'warning',
});

writeFileSync(output, JSON.stringify(config, null, 2));
console.log(
  JSON.stringify({
    ok: true,
    output,
    tcpPort,
    clients: clients.length,
    mode: 'vless-tcp-pilot',
    host: '185.209.230.14',
  })
);
