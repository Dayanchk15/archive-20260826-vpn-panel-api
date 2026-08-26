#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const backupPath = process.argv[2];
if (!backupPath) throw new Error('Usage: node scripts/generate-vps-cdn-configs.mjs <live-backup.json> [output-dir]');
const outputDir = process.argv[3] || path.join('backup', 'generated-cdn');
const backup = JSON.parse(await readFile(backupPath, 'utf8'));
const clients = (backup.users || [])
  .map((entry) => entry.data || entry)
  .filter((user) => user.status === 'active' && user.uuid)
  .map((user) => ({ id: user.uuid, email: user.email || `user-${user.id}`, level: 0 }));

if (!clients.length) throw new Error('No active clients found in backup');

function baseConfig(access, error, apiPort) {
  return {
    log: { access, error, loglevel: 'warning' },
    dns: { queryStrategy: 'UseIPv4', servers: ['1.1.1.1', '8.8.8.8'] },
    policy: {
      levels: {
        0: {
          handshake: 6, connIdle: 300, uplinkOnly: 2, downlinkOnly: 4,
          bufferSize: 4, statsUserUplink: true, statsUserDownlink: true,
        },
      },
      system: { statsInboundUplink: true, statsInboundDownlink: true },
    },
    api: { tag: 'api', services: ['HandlerService', 'StatsService'] },
    stats: {},
    inbounds: [],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'block', protocol: 'blackhole' }],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        { type: 'field', network: 'udp', port: '443', outboundTag: 'block' },
      ],
    },
    _apiPort: apiPort,
  };
}

function addApiInbound(config) {
  config.inbounds.push({
    tag: 'api', listen: '127.0.0.1', port: config._apiPort,
    protocol: 'dokodemo-door', settings: { address: '127.0.0.1' },
  });
  delete config._apiPort;
  return config;
}

function grpcConfig(id, port, apiPort, serviceName) {
  const config = baseConfig(
    `/var/log/vpn-${id}-cloudflare-grpc-access.log`,
    `/var/log/vpn-${id}-cloudflare-grpc-error.log`, apiPort
  );
  config.inbounds.push({
    tag: `${id}-cloudflare-grpc-in`, listen: '127.0.0.1', port, protocol: 'vless',
    settings: { clients, decryption: 'none' },
    streamSettings: {
      network: 'grpc', security: 'none', grpcSettings: { serviceName, multiMode: false },
      sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 60, tcpKeepAliveInterval: 30 },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
  });
  return addApiInbound(config);
}

function wsConfig(id, port, apiPort, wsPath) {
  const config = baseConfig(
    `/var/log/vpn-${id}-bunny-ws-access.log`,
    `/var/log/vpn-${id}-bunny-ws-error.log`, apiPort
  );
  config.inbounds.push({
    tag: `${id}-bunny-ws-in`, listen: '0.0.0.0', port, protocol: 'vless',
    settings: { clients, decryption: 'none' },
    streamSettings: {
      network: 'ws', security: 'none', wsSettings: { path: wsPath },
      sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 60, tcpKeepAliveInterval: 30 },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
  });
  return addApiInbound(config);
}

const files = {
  'tampa-cloudflare-grpc.json': grpcConfig('tampa', 18093, 10093, 'tampa-sync'),
  'fornex-cloudflare-grpc.json': grpcConfig('fornex', 18093, 10093, 'fornex-sync'),
  'fr2-cloudflare-grpc.json': grpcConfig('fr2', 18093, 10093, 'fr2-sync'),
  'tampa-bunny-ws.json': wsConfig('tampa', 18090, 10090, '/bunny/tampa'),
};

await mkdir(outputDir, { recursive: true });
for (const [name, config] of Object.entries(files)) {
  await writeFile(path.join(outputDir, name), JSON.stringify(config, null, 2));
}
console.log(JSON.stringify({ ok: true, outputDir, clients: clients.length, files: Object.keys(files) }, null, 2));
