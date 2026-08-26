#!/usr/bin/env node
/** Generate an isolated, single-user VLESS+WS origin for Tencent EdgeOne on FR1. */
import { writeFileSync } from 'node:fs';
import { listUsers } from '/app/lib/db-store.js';

const listenPort = Number(process.env.TENCENT_WS_PORT || 18108);
const output = String(process.env.OUTPUT || '/tmp/fr1-tencent-ws.json').trim();
const wsPath = String(process.env.TENCENT_WS_PATH || '/edge/fr1/daykoo-v1').trim();
const requestedUserId = String(process.env.TEST_USER_ID || '').trim();
const requestedUserName = String(process.env.TEST_USER_NAME || 'Daykoo VIP').trim().toLowerCase();

if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error('TENCENT_WS_PORT must be a valid TCP port');
}
if (!wsPath.startsWith('/')) throw new Error('TENCENT_WS_PATH must start with /');

const users = await listUsers(5000);
const user =
  users.find((candidate) => requestedUserId && String(candidate.id) === requestedUserId) ||
  users.find((candidate) => String(candidate.name || '').trim().toLowerCase() === requestedUserName);

if (!user?.uuid) throw new Error('The requested Tencent test user was not found');

const config = {
  log: {
    loglevel: 'warning',
    access: '/var/log/vpn-fr1-tencent-ws-access.log',
    error: '/var/log/vpn-fr1-tencent-ws-error.log',
  },
  dns: { queryStrategy: 'UseIPv4', servers: ['1.1.1.1', '8.8.8.8'] },
  inbounds: [{
    tag: 'fr1-tencent-ws-in',
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
      sockopt: {
        tcpNoDelay: true,
        tcpKeepAliveIdle: 60,
        tcpKeepAliveInterval: 30,
      },
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
  user: { id: user.id, name: user.name },
}));
