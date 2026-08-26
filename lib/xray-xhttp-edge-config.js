import { withBlockQuicRouting } from './xray-routing.js';

export const XHTTP_DEFAULT_PATH = '/media/v2/library/sync';
export const XHTTP_DEFAULT_MODE = 'packet-up';

export function buildVlessXhttpEdgeConfig({
  clients = [],
  listenPort = 8443,
  listen = '0.0.0.0',
  logLevel = 'warning',
  xhttpPath = XHTTP_DEFAULT_PATH,
  xhttpHost = '',
  xhttpMode = XHTTP_DEFAULT_MODE,
  tlsCertFile = '/opt/vpn-fr2-xhttp-pilot/cert.pem',
  tlsKeyFile = '/opt/vpn-fr2-xhttp-pilot/key.pem',
  tlsServerName = '',
  includeHandlerApi = false,
  apiPort = 10086,
} = {}) {
  const sni = String(tlsServerName || xhttpHost || 'localhost').trim();

  const inbounds = [
    {
      tag: 'vless-xhttp-in',
      listen,
      port: Number(listenPort),
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
        network: 'xhttp',
        security: 'tls',
        tlsSettings: {
          certificates: [
            {
              certificateFile: tlsCertFile,
              keyFile: tlsKeyFile,
            },
          ],
          alpn: ['h2', 'http/1.1'],
          serverName: sni,
        },
        xhttpSettings: {
          path: xhttpPath,
          host: xhttpHost || sni,
          mode: xhttpMode,
          noGRPCHeader: false,
          noSSEHeader: false,
          scMaxConcurrentPosts: 100,
          scMaxEachPostBytes: '1000000',
          scMinPostsIntervalMs: 30,
          xPaddingBytes: '0',
        },
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
      listen: '127.0.0.1',
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

/** Fastly CDN: TLS at edge, plain xHTTP on origin (most compatible). */
export function buildVlessXhttpFastlyOriginConfig({
  clients = [],
  tlsPort = 8443,
  plainPort = 18444,
  listen = '0.0.0.0',
  logLevel = 'warning',
  xhttpPath = XHTTP_DEFAULT_PATH,
  xhttpHost = '',
  xhttpMode = XHTTP_DEFAULT_MODE,
  tlsCertFile = '/opt/vpn-fr2-xhttp-pilot/cert.pem',
  tlsKeyFile = '/opt/vpn-fr2-xhttp-pilot/key.pem',
  tlsServerName = '',
} = {}) {
  const sni = String(tlsServerName || xhttpHost || 'localhost').trim();
  const xhttpBase = {
    path: xhttpPath,
    host: xhttpHost || sni,
    mode: xhttpMode,
    noGRPCHeader: false,
    noSSEHeader: false,
    scMaxConcurrentPosts: 100,
    scMaxEachPostBytes: '1000000',
    scMinPostsIntervalMs: 30,
    xPaddingBytes: '0',
  };
  const clientList = clients.map((c) => ({
    id: c.uuid,
    email: c.email || c.name || c.userId || c.uuid,
    level: 0,
  }));

  const inbounds = [
    {
      tag: 'vless-xhttp-plain-fastly',
      listen,
      port: Number(plainPort),
      protocol: 'vless',
      settings: { clients: clientList, decryption: 'none' },
      streamSettings: {
        network: 'xhttp',
        security: 'none',
        xhttpSettings: { ...xhttpBase },
        sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 60, tcpKeepAliveInterval: 30 },
      },
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false },
    },
    {
      tag: 'vless-xhttp-tls-direct',
      listen,
      port: Number(tlsPort),
      protocol: 'vless',
      settings: { clients: clientList, decryption: 'none' },
      streamSettings: {
        network: 'xhttp',
        security: 'tls',
        tlsSettings: {
          certificates: [{ certificateFile: tlsCertFile, keyFile: tlsKeyFile }],
          alpn: ['h2', 'http/1.1'],
          serverName: sni,
        },
        xhttpSettings: { ...xhttpBase },
        sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 60, tcpKeepAliveInterval: 30 },
      },
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false },
    },
  ];

  return withBlockQuicRouting({
    log: { loglevel: logLevel },
    dns: { queryStrategy: 'UseIPv4', servers: ['1.1.1.1', '8.8.8.8'] },
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
  });
}

export function buildVlessXhttpPilotLink(user, {
  host,
  port = 8443,
  path = XHTTP_DEFAULT_PATH,
  xhttpHost = '',
  sni = '',
  remark = 'FR2 xHTTP pilot',
  fingerprint = 'chrome',
  alpn = 'h2',
  mode = XHTTP_DEFAULT_MODE,
} = {}) {
  const connectHost = String(host || '').trim();
  const tlsSni = encodeURIComponent(String(sni || xhttpHost || connectHost).trim());
  const tlsHost = encodeURIComponent(String(xhttpHost || connectHost).trim());
  const encPath = encodeURIComponent(path);
  const encRemark = encodeURIComponent(remark);
  const parts = [
    'encryption=none',
    'security=tls',
    'type=xhttp',
    `path=${encPath}`,
    `host=${tlsHost}`,
    `sni=${tlsSni}`,
    `fp=${encodeURIComponent(fingerprint)}`,
    `alpn=${encodeURIComponent(alpn)}`,
    `mode=${encodeURIComponent(mode)}`,
  ];
  return (
    `vless://${user.uuid}@${connectHost}:${port}?${parts.join('&')}#${encRemark}`
  );
}
