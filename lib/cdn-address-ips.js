import { isIP } from 'node:net';

export const CDN_PROVIDER_BUNNY = 'bunny';
export const CDN_PROVIDER_CLOUDFLARE = 'cloudflare';
export const CDN_PROVIDER_TENCENT = 'tencent';
export const CDN_PROVIDER_ALIBABA = 'alibaba';

export const CDN_PROVIDERS = [
  CDN_PROVIDER_TENCENT,
  CDN_PROVIDER_ALIBABA,
  CDN_PROVIDER_CLOUDFLARE,
  CDN_PROVIDER_BUNNY,
];

export const CDN_PROVIDER_LABELS = {
  [CDN_PROVIDER_TENCENT]: 'Tencent EdgeOne',
  [CDN_PROVIDER_ALIBABA]: 'Alibaba ESA',
  [CDN_PROVIDER_CLOUDFLARE]: 'Cloudflare',
  [CDN_PROVIDER_BUNNY]: 'Bunny',
};

function serverSearchText(server) {
  return [
    server?.id,
    server?.name,
    server?.host,
    server?.sni,
    server?.region,
    server?.service,
    server?.country,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

export function classifyCdnServer(server) {
  const host = String(server?.host || '').trim().toLowerCase();
  const text = serverSearchText(server);

  if (host.endsWith('.b-cdn.net') || text.includes('bunny') || /(^|\s|[-_])bn($|\s|[-_])/.test(text)) {
    return CDN_PROVIDER_BUNNY;
  }

  if (
    text.includes('alibaba')
    || text.includes('aliyun')
    || text.includes('alibaba-esa')
    || /^cdn-a\d+\./.test(host)
    || host.startsWith('cdn-a')
  ) {
    return CDN_PROVIDER_ALIBABA;
  }

  if (
    text.includes('tencent')
    || text.includes('edgeone')
    || text.includes('teo')
    || host.includes('daykoo-tencent')
    || text.includes('tencent-edgeone')
  ) {
    return CDN_PROVIDER_TENCENT;
  }

  if (
    host.endsWith('.levospeed.click')
    || (host.endsWith('.shelby-fast.site') && /(cloudflare|finalmask|(^|[-_])cf($|[-_]))/.test(text))
    || text.includes('cloudflare')
    || /(^|\s|[-_])cf($|\s|[-_])/.test(text)
  ) {
    return CDN_PROVIDER_CLOUDFLARE;
  }

  return '';
}

export function normalizeOptionalCdnIp(value, fieldName = 'IP') {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  if (isIP(normalized) !== 4) {
    const error = new Error(`${fieldName} must be a valid IPv4 address`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

/** Normalize a subscription transport port for a CDN server. */
export function normalizeOptionalCdnPort(value, fieldName = 'Port') {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!/^\d+$/.test(raw)) {
    const error = new Error(`${fieldName} must be an integer between 1 and 65535`);
    error.status = 400;
    throw error;
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    const error = new Error(`${fieldName} must be an integer between 1 and 65535`);
    error.status = 400;
    throw error;
  }
  return port;
}

/**
 * Normalize a CDN SNI/Host override.  This intentionally accepts only a
 * DNS hostname (not a URL, port, path, wildcard, or IP address), because the
 * value is written directly into TLS SNI and HTTP Host fields in generated
 * subscription links.
 */
export function normalizeOptionalCdnHostname(value, fieldName = 'SNI/Host') {
  const normalized = String(value ?? '').trim().replace(/\.$/, '').toLowerCase();
  if (!normalized) return '';
  if (normalized.length > 253 || isIP(normalized) !== 0 || normalized.includes('/') || normalized.includes(':')) {
    const error = new Error(`${fieldName} must be a valid DNS hostname`);
    error.status = 400;
    throw error;
  }
  const labels = normalized.split('.');
  if (labels.length < 2 || labels.some((label) => (
    !label
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ))) {
    const error = new Error(`${fieldName} must be a valid DNS hostname`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

export function applyCdnAddressOverrides(current, servers, updates) {
  const next = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  const changedServerIds = [];
  for (const server of servers || []) {
    const provider = classifyCdnServer(server);
    if (!provider || !Object.prototype.hasOwnProperty.call(updates, provider)) continue;
    const value = updates[provider];
    if (value) next[String(server.id)] = value;
    else delete next[String(server.id)];
    changedServerIds.push(String(server.id));
  }
  return { serverAddressIps: next, changedServerIds };
}

function summarizeProvider(provider, user, servers) {
  const overrides = user?.serverAddressIps && typeof user.serverAddressIps === 'object'
    ? user.serverAddressIps
    : {};
  const matching = (servers || []).filter((server) => classifyCdnServer(server) === provider);
  const customIps = [...new Set(matching.map((server) => String(overrides[server.id] || '').trim()).filter(Boolean))];
  const effectiveIps = [...new Set(matching.map((server) => (
    String(overrides[server.id] || server.addressIp || '').trim()
  )).filter(Boolean))];
  return {
    serverCount: matching.length,
    customIp: customIps.length === 1 ? customIps[0] : '',
    customIps,
    effectiveIps,
    usesCustom: customIps.length > 0,
    mixed: customIps.length > 1,
  };
}

export function summarizeCdnAddressOverrides(user, servers) {
  return {
    bunny: summarizeProvider(CDN_PROVIDER_BUNNY, user, servers),
    cloudflare: summarizeProvider(CDN_PROVIDER_CLOUDFLARE, user, servers),
    tencent: summarizeProvider(CDN_PROVIDER_TENCENT, user, servers),
    alibaba: summarizeProvider(CDN_PROVIDER_ALIBABA, user, servers),
  };
}

export function listServersByCdnProvider(servers = []) {
  const groups = Object.fromEntries(CDN_PROVIDERS.map((id) => [id, []]));
  for (const server of servers) {
    if (server?.enabled === false) continue;
    const provider = classifyCdnServer(server);
    if (!provider || !groups[provider]) continue;
    groups[provider].push(server);
  }
  return groups;
}

export function buildCdnServicesSummary(servers = []) {
  const groups = listServersByCdnProvider(servers);
  return CDN_PROVIDERS.map((provider) => {
    const list = groups[provider] || [];
    const ips = [...new Set(list.map((s) => String(s.addressIp || '').trim()).filter(Boolean))];
    const hosts = [...new Set(list.map((s) => String(s.host || '').trim()).filter(Boolean))];
    const snis = [...new Set(list.map((s) => String(s.sni || '').trim()).filter(Boolean))];
    return {
      id: provider,
      label: CDN_PROVIDER_LABELS[provider] || provider,
      serverCount: list.length,
      sharedIp: ips.length === 1 ? ips[0] : '',
      mixed: ips.length > 1,
      ips,
      sharedHost: hosts.length === 1 ? hosts[0] : '',
      sharedSni: snis.length === 1 ? snis[0] : '',
      hosts,
      snis,
      mixedHost: hosts.length > 1,
      mixedSni: snis.length > 1,
      servers: list
        .slice()
        .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
        .map((server) => ({
          id: server.id,
          name: server.name || server.id,
          host: server.host || '',
          sni: server.sni || '',
          path: server.path || '',
          port: Number(server.port || 443),
          addressIp: server.addressIp || '',
          forceAddressIp: server.forceAddressIp === true,
          country: server.country || '',
          region: server.region || '',
        })),
    };
  }).filter((row) => row.serverCount > 0);
}
