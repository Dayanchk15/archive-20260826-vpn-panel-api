#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { buildEdgeClientList } from '../lib/edge-clients.js';

const listenPort = Number(process.env.CF_WS_PORT || 18094);
const apiPort = Number(process.env.CF_WS_API_PORT || 10094);
const wsPath = String(process.env.CF_WS_PATH || '/').trim();
const output = String(process.env.OUTPUT || '/data/files/cloudflare-ws-origin.json').trim();
const clients = await buildEdgeClientList();
const extraUuid = String(process.env.CF_WS_EXTRA_UUID || '').trim().toLowerCase();
if (
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(extraUuid) &&
  !clients.some((client) => String(client.uuid || '').trim().toLowerCase() === extraUuid)
) {
  clients.push({
    userId: 'cloudflare-speed-test',
    uuid: extraUuid,
    email: 'cf-speed',
    name: 'Cloudflare speed test',
  });
}

const config = {
  log: {
    loglevel: 'warning',
    access: '/var/log/xray-cloudflare-ws-access.log',
    error: '/var/log/xray-cloudflare-ws-error.log',
  },
  dns: { queryStrategy: 'UseIPv4', servers: ['1.1.1.1', '8.8.8.8'] },
  policy: {
    levels: {
      0: {
        handshake: 8,
        connIdle: 300,
        uplinkOnly: 2,
        downlinkOnly: 5,
        statsUserUplink: true,
        statsUserDownlink: true,
        bufferSize: 512,
      },
    },
    system: { statsInboundUplink: true, statsInboundDownlink: true },
  },
  api: { tag: 'api', services: ['HandlerService', 'LoggerService', 'StatsService'] },
  stats: {},
  inbounds: [
    {
      tag: 'cloudflare-ws-in',
      listen: '127.0.0.1',
      port: listenPort,
      protocol: 'vless',
      settings: {
        clients: clients.map((client) => ({
          id: client.uuid,
          email: client.email || client.name || client.userId || client.uuid,
          level: 0,
        })),
        decryption: 'none',
      },
      streamSettings: {
        network: 'ws',
        security: 'none',
        wsSettings: { path: wsPath },
        sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 60, tcpKeepAliveInterval: 30 },
      },
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
    },
    {
      tag: 'api',
      listen: '127.0.0.1',
      port: apiPort,
      protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1' },
    },
  ],
  outbounds: [
    { tag: 'direct', protocol: 'freedom' },
    { tag: 'block', protocol: 'blackhole' },
  ],
  routing: {
    domainStrategy: 'AsIs',
    rules: [{ type: 'field', inboundTag: ['api'], outboundTag: 'api' }],
  },
};

writeFileSync(output, JSON.stringify(config, null, 2));
console.log(JSON.stringify({ ok: true, output, listenPort, apiPort, wsPath, clients: clients.length }));
