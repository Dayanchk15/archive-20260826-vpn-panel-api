#!/usr/bin/env node
/** Generate a single-user plaintext VLESS+WS origin for the isolated FR1 Bunny pilot. */
import { writeFileSync } from 'fs';
import { listUsers } from '/app/lib/db-store.js';

const listenPort = Number(process.env.BUNNY_WS_PORT || 18092);
const output = String(process.env.OUTPUT || '/tmp/fr1-bunny-ws.json').trim();
const wsPath = String(process.env.BUNNY_WS_PATH || '/media/v3/fr1/ws').trim();
const requestedUserId = String(process.env.TEST_USER_ID || '').trim();
const requestedUserName = String(process.env.TEST_USER_NAME || 'Dayanch VIP').trim().toLowerCase();

const users = await listUsers(5000);
const user =
  users.find((candidate) => requestedUserId && candidate.id === requestedUserId) ||
  users.find((candidate) => String(candidate.name || '').trim().toLowerCase() === requestedUserName);

if (!user?.uuid) throw new Error('The requested test user was not found');

const config = {
  log: { loglevel: 'warning' },
  dns: { queryStrategy: 'UseIPv4', servers: ['1.1.1.1', '8.8.8.8'] },
  inbounds: [{
    tag: 'fr1-bunny-ws-in',
    listen: '0.0.0.0',
    port: listenPort,
    protocol: 'vless',
    settings: {
      clients: [{ id: user.uuid, email: user.name || user.id, level: 0 }],
      decryption: 'none',
    },
    streamSettings: {
      network: 'ws',
      security: 'none',
      wsSettings: { path: wsPath },
      sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 60, tcpKeepAliveInterval: 30 },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls'], routeOnly: true },
  }],
  outbounds: [
    { tag: 'direct', protocol: 'freedom' },
    { tag: 'block', protocol: 'blackhole' },
  ],
};

writeFileSync(output, JSON.stringify(config, null, 2));
console.log(JSON.stringify({
  ok: true,
  output,
  listenPort,
  wsPath,
  user: { id: user.id, name: user.name, uuid: user.uuid },
}));
