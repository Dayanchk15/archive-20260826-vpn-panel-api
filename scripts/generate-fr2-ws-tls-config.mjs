#!/usr/bin/env node
/**
 * Generate VLESS + WebSocket + TLS edge config for FR2 (direct-to-VPS, competitor-style).
 */
import { writeFileSync } from 'fs';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';
import { buildVlessWsTlsEdgeConfig, WS_TLS_DEFAULT_PATH } from '/app/lib/xray-ws-tls-edge-config.js';

const listenPort = Number(process.env.WS_PORT || 443);
const output = String(process.env.OUTPUT || '/data/files/fr2-ws-tls.json').trim();
const domain = String(process.env.WS_DOMAIN || 'fr2direct.levospeed.click').trim();
const wsPath = String(process.env.WS_PATH || WS_TLS_DEFAULT_PATH).trim();
const pilotDir = String(process.env.WS_DIR || '/opt/vpn-fr2-ws').trim();

const clients = await buildEdgeClientList();
const config = buildVlessWsTlsEdgeConfig({
  clients,
  listenPort,
  wsPath,
  wsHost: domain,
  tlsServerName: domain,
  tlsCertFile: `${pilotDir}/fullchain.pem`,
  tlsKeyFile: `${pilotDir}/key.pem`,
  accessLog: '/var/log/vpn-fr2-ws-access.log',
  errorLog: '/var/log/vpn-fr2-ws-error.log',
});

writeFileSync(output, JSON.stringify(config, null, 2));
console.log(JSON.stringify({ ok: true, output, listenPort, domain, wsPath, clients: clients.length }));
