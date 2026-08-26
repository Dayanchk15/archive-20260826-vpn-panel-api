#!/usr/bin/env node
/**
 * Generate VLESS xHTTP + TLS pilot config for FR2.
 */
import { writeFileSync } from 'fs';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';
import {
  buildVlessXhttpEdgeConfig,
  XHTTP_DEFAULT_MODE,
  XHTTP_DEFAULT_PATH,
} from '/app/lib/xray-xhttp-edge-config.js';

const listenPort = Number(process.env.XHTTP_PORT || 8443);
const output = String(process.env.OUTPUT || '/data/files/fr2-xhttp-pilot.json').trim();
const fr2Ip = String(process.env.FR2_IP || '185.209.230.46').trim();
const xhttpDomain = String(process.env.XHTTP_DOMAIN || 'france2.levospeed.click').trim();
const xhttpPath = String(process.env.XHTTP_PATH || XHTTP_DEFAULT_PATH).trim();
const xhttpMode = String(process.env.XHTTP_MODE || XHTTP_DEFAULT_MODE).trim();
const pilotDir = String(process.env.PILOT_DIR || '/opt/vpn-fr2-xhttp-pilot').trim();

const clients = await buildEdgeClientList();
const config = buildVlessXhttpEdgeConfig({
  clients,
  listenPort,
  xhttpPath,
  xhttpHost: xhttpDomain,
  xhttpMode,
  tlsCertFile: `${pilotDir}/cert.pem`,
  tlsKeyFile: `${pilotDir}/key.pem`,
  tlsServerName: xhttpDomain,
});

writeFileSync(output, JSON.stringify(config, null, 2));
console.log(
  JSON.stringify({
    ok: true,
    output,
    listenPort,
    clients: clients.length,
    mode: 'vless-xhttp-tls-pilot',
    host: fr2Ip,
    xhttpPath,
    xhttpMode,
  })
);
