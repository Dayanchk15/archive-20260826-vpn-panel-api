#!/usr/bin/env node
/** Generate a single-user, plain HTTP XHTTP origin for the isolated FR1 Bunny pilot. */
import { writeFileSync } from 'fs';
import { listUsers } from '/app/lib/db-store.js';

const listenPort = Number(process.env.XHTTP_PORT || 18092);
const output = String(process.env.OUTPUT || '/tmp/fr1-bunny-xhttp.json').trim();
const xhttpPath = String(process.env.XHTTP_PATH || '/media/v3/fr1/sync').trim();
const xhttpHost = String(process.env.XHTTP_HOST || 'levospeedfr1xhttp.b-cdn.net').trim();
const requestedUserId = String(process.env.TEST_USER_ID || '').trim();
const requestedUserName = String(process.env.TEST_USER_NAME || 'Dayanch VIP').trim().toLowerCase();

const users = await listUsers(5000);
const user =
  users.find((candidate) => requestedUserId && candidate.id === requestedUserId) ||
  users.find((candidate) => String(candidate.name || '').trim().toLowerCase() === requestedUserName) ||
  users.find((candidate) => candidate.status === 'active');

if (!user?.uuid) {
  throw new Error('No active test user with UUID was found');
}

const config = {
  log: { loglevel: 'warning' },
  dns: { queryStrategy: 'UseIPv4', servers: ['1.1.1.1', '8.8.8.8'] },
  policy: {
    levels: {
      0: {
        handshake: 8,
        connIdle: 120,
        uplinkOnly: 2,
        downlinkOnly: 5,
        bufferSize: 512,
      },
    },
  },
  inbounds: [
    {
      tag: 'fr1-bunny-xhttp-in',
      listen: '0.0.0.0',
      port: listenPort,
      protocol: 'vless',
      settings: {
        clients: [{ id: user.uuid, email: user.name || user.id, level: 0 }],
        decryption: 'none',
      },
      streamSettings: {
        network: 'xhttp',
        security: 'none',
        xhttpSettings: {
          path: xhttpPath,
          host: xhttpHost,
          mode: 'packet-up',
          noGRPCHeader: false,
          noSSEHeader: false,
          scMaxConcurrentPosts: 100,
          scMaxEachPostBytes: '1000000',
          scMinPostsIntervalMs: 30,
          xPaddingBytes: '0',
        },
        sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 60, tcpKeepAliveInterval: 30 },
      },
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false },
    },
  ],
  outbounds: [
    { tag: 'direct', protocol: 'freedom' },
    { tag: 'block', protocol: 'blackhole' },
  ],
  routing: {
    domainStrategy: 'AsIs',
    rules: [
      { type: 'field', network: 'udp', port: '443', outboundTag: 'block' },
    ],
  },
};

writeFileSync(output, JSON.stringify(config, null, 2));
console.log(JSON.stringify({
  ok: true,
  output,
  listenPort,
  xhttpPath,
  xhttpHost,
  user: { id: user.id, name: user.name, uuid: user.uuid },
}));
