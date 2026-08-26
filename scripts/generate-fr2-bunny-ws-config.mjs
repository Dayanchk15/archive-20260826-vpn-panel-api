#!/usr/bin/env node
/** Generate an isolated plaintext VLESS+WS origin for Bunny CDN on FR2. */
import { writeFileSync } from 'node:fs';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';

const listenPort = Number(process.env.BUNNY_WS_PORT || 18090);
const apiPort = Number(process.env.BUNNY_API_PORT || 10089);
const wsPath = String(process.env.BUNNY_WS_PATH || '/bunny/fr2').trim();
const output = String(process.env.OUTPUT || '/data/files/fr2-bunny-ws.json').trim();
const clients = await buildEdgeClientList();

const config = {
  log: {
    loglevel: 'warning',
    access: '/var/log/vpn-fr2-bunny-ws-access.log',
    error: '/var/log/vpn-fr2-bunny-ws-error.log',
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
      tag: 'vless-bunny-ws-in',
      listen: '0.0.0.0',
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
