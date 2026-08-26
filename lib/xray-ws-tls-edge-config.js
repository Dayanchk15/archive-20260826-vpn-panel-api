import { withBlockQuicRouting } from './xray-routing.js';

export const WS_TLS_DEFAULT_PATH = '/';

/**
 * VLESS + WebSocket + TLS inbound for a direct-to-VPS edge (competitor-style).
 * DPI bypass is done client-side via TLS ClientHello fragmentation (finalmask),
 * so the server only needs a normal WS+TLS listener on 443.
 */
export function buildVlessWsTlsEdgeConfig({
  clients = [],
  listenPort = 443,
  listen = '0.0.0.0',
  logLevel = 'warning',
  wsPath = WS_TLS_DEFAULT_PATH,
  wsHost = '',
  tlsCertFile = '/opt/vpn-fr2-ws/fullchain.pem',
  tlsKeyFile = '/opt/vpn-fr2-ws/key.pem',
  tlsServerName = '',
  accessLog = '',
  errorLog = '',
} = {}) {
  const sni = String(tlsServerName || wsHost || 'localhost').trim();
  const host = String(wsHost || sni).trim();

  const inbound = {
    tag: 'vless-ws-tls-in',
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
      network: 'ws',
      security: 'tls',
      tlsSettings: {
        certificates: [{ certificateFile: tlsCertFile, keyFile: tlsKeyFile }],
        alpn: ['http/1.1'],
        serverName: sni,
        minVersion: '1.2',
      },
      wsSettings: {
        path: wsPath,
        host,
        headers: { Host: host },
      },
      sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 60, tcpKeepAliveInterval: 30 },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false },
  };

  const log = { loglevel: logLevel };
  if (accessLog) log.access = accessLog;
  if (errorLog) log.error = errorLog;

  return withBlockQuicRouting({
    log,
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
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: false,
        statsOutboundDownlink: false,
      },
    },
    inbounds: [inbound],
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
  });
}

/**
 * Build the competitor-style client link: VLESS + WS + TLS with client-side
 * TLS fragmentation (finalmask). The `fragment=` URI param is what hides the SNI.
 */
export function buildVlessWsTlsLink(user, {
  host,
  port = 443,
  path = WS_TLS_DEFAULT_PATH,
  sni = '',
  remark = 'FR2 WS-TLS',
  fingerprint = 'chrome',
} = {}) {
  const connectHost = String(host || '').trim();
  const tlsSni = String(sni || connectHost).trim();
  const params = [
    'encryption=none',
    'security=tls',
    'type=ws',
    `path=${encodeURIComponent(path)}`,
    `host=${encodeURIComponent(connectHost)}`,
    `sni=${encodeURIComponent(tlsSni)}`,
    `fp=${encodeURIComponent(fingerprint)}`,
    'alpn=http%2F1.1',
    // client-side TLS ClientHello fragmentation to defeat SNI-based DPI
    'fragment=tlshello%2C3-3%2C0-1',
  ];
  return `vless://${user.uuid}@${connectHost}:${port}?${params.join('&')}#${encodeURIComponent(remark)}`;
}
