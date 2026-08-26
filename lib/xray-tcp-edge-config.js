import { withBlockQuicRouting } from './xray-routing.js';

export const RELAY_WS_PATH = '/api/v1/socket';
/** Per-edge public TCP port (host); docker edges map host:edgePort -> container:8080 */
export const RELAY_TCP_UPSTREAM_PORT = 8443;

const PRIVATE_IP_BLOCK_RULE = {
  type: 'field',
  ip: ['geoip:private'],
  outboundTag: 'block',
};

// geoip:private requires geoip.dat on VPS — not used in prod edges
void PRIVATE_IP_BLOCK_RULE;

export function buildVlessTcpEdgeConfig({
  clients = [],
  tcpPort = RELAY_TCP_UPSTREAM_PORT,
  listen = '0.0.0.0',
  logLevel = 'warning',
  includeHandlerApi = true,
  apiPort = 10085,
} = {}) {
  const inbounds = [
    {
      tag: 'vless-tcp-in',
      listen,
      port: Number(tcpPort),
      protocol: 'vless',
      settings: {
        clients: clients.map((c) => ({
          id: c.uuid,
          email: c.email || c.name || c.userId || c.uuid,
          level: 0,
        })),
        decryption: 'none',
      },
      streamSettings: {
        network: 'tcp',
        security: 'none',
        sockopt: {
          tcpNoDelay: true,
          tcpKeepAliveIdle: 60,
          tcpKeepAliveInterval: 30,
        },
      },
      sniffing: {
        enabled: true,
        destOverride: ['http', 'tls', 'quic'],
        routeOnly: false,
      },
    },
  ];

  if (includeHandlerApi) {
    inbounds.push({
      listen: '0.0.0.0',
      port: Number(apiPort),
      protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1' },
      tag: 'api',
    });
  }

  const config = {
    log: { loglevel: logLevel },
    dns: {
      queryStrategy: 'UseIPv4',
      servers: ['1.1.1.1', '8.8.8.8'],
    },
    policy: {
      levels: {
        0: {
          handshake: 8,
          connIdle: 120,
          uplinkOnly: 2,
          downlinkOnly: 5,
          statsUserUplink: true,
          statsUserDownlink: true,
          bufferSize: 512,
        },
      },
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: false,
        statsOutboundDownlink: false,
      },
    },
    inbounds,
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
  };

  if (includeHandlerApi) {
    config.stats = {};
    config.api = { tag: 'api', services: ['StatsService', 'HandlerService'] };
  }

  return withBlockQuicRouting(config);
}

export function edgeTcpUpstreamAddr(ip, port = RELAY_TCP_UPSTREAM_PORT) {
  return `${String(ip).trim()}:${Number(port)}`;
}
