import { encodeHappServerRemark, encodeVlessRemark } from './vless-remark.js';
import {
  buildVlessFragmentQueryParam,
  resolveHappFragmentation,
} from './happ-fragmentation.js';
import { RELAY_WS_PATH } from './xray-tcp-edge-config.js';

export function formatServerRemark(server) {
  const flag = String(server?.flag || '').trim();
  const country = String(server?.country || 'Server').trim();
  const text = [server?.id, server?.service, server?.name, server?.host, server?.region]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  // Place tags must ignore host/SNI — hub hostname can contain fr1 and would
  // mislabel FR2/Fornex/Tampa TE lines as France FR1.
  const placeText = [server?.id, server?.service, server?.name]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  let suffix = '';
  if (text.includes('cloudflare') || /\bcf\b/.test(text)) {
    suffix = 'CF';
  } else if (text.includes('bunny') || text.includes('b-cdn.net') || /\bbn\b/.test(text)) {
    suffix = 'BN';
  } else if (text.includes('tencent') || text.includes('edgeone') || /\bteo\b/.test(text)) {
    suffix = 'TE';
  } else if (
    text.includes('alibaba') ||
    text.includes('aliyun') ||
    text.includes('alibabacloud') ||
    /\bali\b/.test(text)
  ) {
    suffix = 'ALI';
  } else if (text.includes('relay-eu-') || text.includes('glb-vps')) {
    suffix = '[No Block]';
  }
  // Disambiguate same-country edges so Happ does not collapse duplicates
  // (e.g. two "France BN" / "France CF" → only one shown).
  let place = '';
  if (
    /(^|[^a-z])fr1([^a-z]|$)/.test(placeText) ||
    placeText.includes('bunny-az-fr1') ||
    placeText.includes('cloudflare-finalmask-fr1') ||
    placeText.includes('tencent-edgeone-fr1')
  ) {
    place = 'FR1';
  } else if (
    /(^|[^a-z])fr2([^a-z]|$)/.test(placeText) ||
    placeText.includes('bunny-az-fr2') ||
    placeText.includes('cloudflare-fr2') ||
    placeText.includes('tencent-edgeone-fr2')
  ) {
    place = 'FR2';
  }
  const title = suffix
    ? (place ? `${country} ${place} ${suffix}` : `${country} ${suffix}`)
    : (place ? `${country} ${place}` : country);
  return flag ? `${flag} ${title}` : title;
}

function buildAuthority(hostOrIp, port) {
  const value = String(hostOrIp || '').trim();
  if (!value) return '';
  if (/:\d+$/.test(value)) return value;
  return `${value}:${port || 443}`;
}

function buildFinalMaskQueryParam(server) {
  const finalMask = server?.finalMask;
  if (!finalMask || typeof finalMask !== 'object' || Array.isArray(finalMask)) return '';
  const json = JSON.stringify(finalMask);
  // Happ share links use a double-encoded `fm` payload. The first URL decode
  // yields the percent-encoded JSON that Happ decodes into streamSettings.finalmask.
  return `fm=${encodeURIComponent(encodeURIComponent(json))}`;
}

function serializeXhttpExtra(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

const DISABLED_PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000000';
const DISABLED_PLACEHOLDER_HOST = '127.0.0.1';
const DISABLED_PLACEHOLDER_PORT = 1;

export function buildDisabledPlaceholderLink({ server, label } = {}) {
  const remark = label || formatServerRemark(server);
  return (
    `vless://${DISABLED_PLACEHOLDER_UUID}@${buildAuthority(
      DISABLED_PLACEHOLDER_HOST,
      DISABLED_PLACEHOLDER_PORT
    )}` +
    '?security=none&type=ws&headerType=&path=%2F&host=' +
    `#${encodeVlessRemark(remark)}`
  );
}

export function buildVlessLink(user, server, options = {}) {
  const connectionMode = options.connectionMode || 'masked';
  const nodeHost = String(server.host || '').trim();
  const connectOverride = String(options.connectAddressIp || '').trim();
  const addressIp = connectOverride || String(server.addressIp || '').trim();
  const port = server.port || 443;
  const security = server.security || 'tls';
  const network = server.network || 'ws';
  const isReality = security === 'reality';
  const isDirectTcp = network === 'tcp' && security === 'none';
  const requiresDirectAddress = isReality || isDirectTcp;
  const forceAddressIp = server.forceAddressIp === true || options.forceAddressIp === true;
  const useMasked =
    !requiresDirectAddress &&
    Boolean(addressIp) &&
    (forceAddressIp || connectionMode === 'masked');
  const connectHost = requiresDirectAddress
    ? String(server.addressIp || nodeHost).trim()
    : useMasked
      ? addressIp
      : nodeHost;
  const sni = encodeURIComponent(server.sni || 'www.google.com');
  const fingerprint = server.fingerprint || 'chrome';
  const alpn = server.alpn || 'http/1.1';
  const remarkDesc = String(options.serverDescription || '').trim();
  const remarkTitle = String(options.subscriptionRemark || '').trim() || formatServerRemark(server);
  const remark = requiresDirectAddress
    ? encodeVlessRemark(remarkTitle)
    : remarkDesc
    ? encodeHappServerRemark(remarkTitle, remarkDesc)
    : encodeVlessRemark(remarkTitle);

  // A server-scoped legacy `fragment=` preset is understood by older Happ
  // Android builds that may omit newer `fm` profiles during import. It takes
  // precedence over subscription-wide settings and therefore can be limited
  // to selected CDN profiles without changing relay links.
  // Note: options.fragmentation may be explicitly null (Dayanch VIP) — do not
  // treat that as "missing" via ?? or panel defaults will re-enable fragment.
  let fragmentation = null;
  if (!server?.finalMask) {
    if (server?.fragmentation != null) {
      fragmentation = server.fragmentation;
    } else if (Object.prototype.hasOwnProperty.call(options, 'fragmentation')) {
      fragmentation = options.fragmentation;
    } else {
      fragmentation = resolveHappFragmentation(options.panelSettings || {});
    }
  }
  const fragmentParam = buildVlessFragmentQueryParam(fragmentation, {
    literal: server?.fragmentationEncoding === 'literal',
  });
  const finalMaskParam = buildFinalMaskQueryParam(server);

  let parts;
  if (isReality) {
    const publicKey = String(server.realityPublicKey || server.publicKey || '').trim();
    const shortId = String(server.realityShortId || server.shortId || '').trim();
    if (!publicKey || !shortId) {
      throw new Error(`REALITY server "${server.id || server.name || 'unknown'}" is missing public key or short ID`);
    }
    parts = [
      'encryption=none',
      `flow=${encodeURIComponent(server.flow || 'xtls-rprx-vision')}`,
      'security=reality',
      `sni=${sni}`,
      `fp=${encodeURIComponent(fingerprint)}`,
      `pbk=${encodeURIComponent(publicKey)}`,
      `sid=${encodeURIComponent(shortId)}`,
      `spx=${encodeURIComponent(server.spiderX || '/')}`,
      'type=tcp',
      'headerType=none',
    ];
  } else if (isDirectTcp) {
    parts = [
      'encryption=none',
      'security=none',
      'type=tcp',
      'headerType=none',
    ];
  } else if (network === 'grpc') {
    const serviceName = encodeURIComponent(
      server.grpcServiceName || server.path || 'grpc-api-v1'
    );
    parts = [
      'encryption=none',
      `security=${security}`,
      'type=grpc',
      'mode=gun',
      `serviceName=${serviceName}`,
      `host=${nodeHost}`,
      `authority=${encodeURIComponent(server.grpcAuthority || nodeHost)}`,
      `sni=${sni}`,
      `fp=${encodeURIComponent(fingerprint)}`,
      `alpn=${encodeURIComponent(server.alpn || 'h2')}`,
    ];
  } else {
    const path = encodeURIComponent(server.path || RELAY_WS_PATH);
    // Happ's FinalMask importer expects the same compact share-link layout
    // produced by its exporter: `fm` first and no generic VLESS/header fields.
    // Keep this isolated to explicit FinalMask profiles so existing links stay byte-stable.
    parts = server.compactWsShareLink === true && network === 'ws'
      ? [
          `type=${network}`,
          `host=${nodeHost}`,
          `path=${String(server.path || '/')}`,
          `security=${security}`,
          `sni=${sni}`,
          `alpn=${String(alpn)}`,
          `fp=${encodeURIComponent(fingerprint)}`,
        ]
      : finalMaskParam && network === 'ws'
      ? [
          finalMaskParam,
          `type=${network}`,
          `host=${nodeHost}`,
          `path=${path}`,
          `security=${security}`,
          `sni=${sni}`,
          `alpn=${encodeURIComponent(alpn)}`,
          `fp=${encodeURIComponent(fingerprint)}`,
          'allowInsecure=0',
        ]
      : [
          'encryption=none',
          `security=${security}`,
          `type=${network}`,
          'headerType=',
          `path=${path}`,
          `host=${nodeHost}`,
          `sni=${sni}`,
          `fp=${encodeURIComponent(fingerprint)}`,
          `alpn=${encodeURIComponent(alpn)}`,
        ];
    if (network === 'xhttp') {
      // Happ Android imports mode=auto more reliably than packet-up, but packet-up
      // is the preferred mode for anti-detection on fresh xhttp servers.
      parts.push(`mode=${encodeURIComponent(server.xhttpMode || server.mode || 'packet-up')}`);
      // xhttp streaming/connection-pool tuning (xmux, padding, chunk sizes). When
      // present, emitted as the client `extra` param exactly like the share-link spec.
      const xhttpExtra = serializeXhttpExtra(server.xhttpExtra);
      if (xhttpExtra) {
        parts.push(`extra=${encodeURIComponent(xhttpExtra)}`);
      }
    }
  }
  if (server.allowInsecure === true && !parts.some((part) => part.startsWith('allowInsecure='))) {
    parts.push('allowInsecure=true');
  }
  if (server.rejectUdp443 === true) parts.push('xudpProxyUDP443=reject');
  // FinalMask `fm=` is a Happ WS share-link extension. Attaching it to xHTTP
  // makes Happ Android drop those rows on import (iOS still shows them).
  if (
    finalMaskParam &&
    network === 'ws' &&
    !requiresDirectAddress &&
    !parts.includes(finalMaskParam)
  ) {
    parts.push(finalMaskParam);
  }
  // Legacy fragment= also breaks xHTTP import on some Android Happ builds.
  if (fragmentParam && network !== 'xhttp' && !requiresDirectAddress) {
    parts.push(fragmentParam);
  }

  return (
    `vless://${user.uuid}@${buildAuthority(connectHost, port)}` +
    `?${parts.join('&')}` +
    `#${remark}`
  );
}

/** Info-строка для Happ: fake VLESS как обычный ручной WebSocket, но без TLS. */
export function buildInfoRowVlessLink(uuid, { host = 'www.google.com', port = 80, label, serverDescription }) {
  const safeUuid = String(uuid || '').trim();
  if (!safeUuid) {
    throw new Error('clientUuid is required for info subscription rows');
  }
  const infoHost = String(host || 'www.google.com').trim();
  const infoPort = port || 80;
  const remark = serverDescription
    ? encodeHappServerRemark(label, serverDescription)
    : encodeVlessRemark(label);
  return (
    `vless://${safeUuid}@${buildAuthority(infoHost, infoPort)}` +
    '?security=none&type=ws&headerType=&path=%2F&host=' +
    `#${remark}`
  );
}
