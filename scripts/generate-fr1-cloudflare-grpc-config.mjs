#!/usr/bin/env node
/** Generate an isolated single-user VLESS+gRPC origin for FR1/Cloudflare. */
import { writeFileSync } from 'node:fs';
import { listUsers } from '/app/lib/db-store.js';

const output = String(process.env.OUTPUT || '/tmp/fr1-cloudflare-grpc.json').trim();
const listenPort = Number(process.env.GRPC_PORT || 18093);
const serviceName = String(process.env.GRPC_SERVICE_NAME || 'fr1sync').trim();
const requestedUserId = String(process.env.TEST_USER_ID || 'usr_bnjXUy4O1NZufeqW').trim();

const users = await listUsers(5000);
const user = users.find((candidate) => candidate.id === requestedUserId);
if (!user?.uuid) throw new Error(`Test user ${requestedUserId} was not found`);

const config = {
  log: {
    access: '/var/log/vpn-fr1-cloudflare-grpc-access.log',
    error: '/var/log/vpn-fr1-cloudflare-grpc-error.log',
    loglevel: 'warning',
  },
  dns: { queryStrategy: 'UseIPv4', servers: ['1.1.1.1', '8.8.8.8'] },
  policy: {
    levels: {
      8: {
        handshake: 6,
        connIdle: 300,
        uplinkOnly: 2,
        downlinkOnly: 5,
        bufferSize: 512,
      },
    },
  },
  inbounds: [{
    tag: 'fr1-cloudflare-grpc-in',
    listen: '127.0.0.1',
    port: listenPort,
    protocol: 'vless',
    settings: {
      clients: [{ id: user.uuid, email: user.name || user.id, level: 8 }],
      decryption: 'none',
    },
    streamSettings: {
      network: 'grpc',
      security: 'none',
      grpcSettings: { serviceName, multiMode: false },
      sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 60, tcpKeepAliveInterval: 30 },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
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
  serviceName,
  user: { id: user.id, name: user.name, uuid: user.uuid },
}));
