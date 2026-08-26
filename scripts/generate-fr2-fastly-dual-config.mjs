#!/usr/bin/env node
/**
 * FR2 dual xHTTP: plain :18444 for Fastly origin, TLS :8443 for direct test.
 */
import { writeFileSync } from 'fs';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';
import { buildVlessXhttpFastlyOriginConfig, XHTTP_DEFAULT_PATH } from '/app/lib/xray-xhttp-edge-config.js';

const plainPort = Number(process.env.FASTLY_PLAIN_PORT || 18444);
const tlsPort = Number(process.env.XHTTP_PORT || 8443);
const output = String(process.env.OUTPUT || '/data/files/fr2-fastly-dual.json').trim();
const domain = String(process.env.XHTTP_DOMAIN || 'france2.levospeed.click').trim();
const pilotDir = '/opt/vpn-fr2-xhttp-pilot';

const clients = await buildEdgeClientList();
const config = buildVlessXhttpFastlyOriginConfig({
  clients,
  plainPort,
  tlsPort,
  xhttpPath: process.env.XHTTP_PATH || XHTTP_DEFAULT_PATH,
  xhttpHost: domain,
  xhttpMode: 'packet-up',
  tlsCertFile: `${pilotDir}/cert.pem`,
  tlsKeyFile: `${pilotDir}/key.pem`,
  tlsServerName: domain,
});

writeFileSync(output, JSON.stringify(config, null, 2));
console.log(JSON.stringify({ ok: true, output, plainPort, tlsPort, domain, clients: clients.length }));
