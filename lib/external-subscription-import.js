import dns from 'node:dns/promises';
import net from 'node:net';

const SUPPORTED_LINK = /^(?:vless|vmess|ss|ssr|trojan|hysteria2|hy2|tuic|wireguard):\/\//i;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LINKS = 500;

export function extractExternalSubscriptionLinks(body, { maxLinks = DEFAULT_MAX_LINKS } = {}) {
  const source = String(body || '').replace(/^\uFEFF/, '').trim();
  if (!source) return [];

  const candidates = [source];
  const decoded = decodePossibleBase64(source);
  if (decoded && decoded !== source) candidates.push(decoded);

  const jsonStrings = collectJsonStrings(source);
  if (decoded) jsonStrings.push(...collectJsonStrings(decoded));
  candidates.push(...jsonStrings);

  const links = [];
  const seen = new Set();
  for (const candidate of candidates) {
    for (const token of String(candidate || '').split(/[\r\n\t ]+/)) {
      const value = token.trim().replace(/^['"]|['",]$/g, '');
      if (!SUPPORTED_LINK.test(value) || seen.has(value)) continue;
      seen.add(value);
      links.push(value);
      if (links.length >= maxLinks) return links;
    }
  }
  return links;
}

export function summarizeExternalSubscriptionLinks(links) {
  const protocols = {};
  for (const link of Array.isArray(links) ? links : []) {
    const protocol = String(link).split(':', 1)[0].toLowerCase();
    protocols[protocol] = (protocols[protocol] || 0) + 1;
  }
  return { total: Array.isArray(links) ? links.length : 0, protocols };
}

export async function fetchExternalSubscription(
  inputUrl,
  { timeoutMs = 15000, maxBytes = DEFAULT_MAX_BYTES, maxRedirects = 4, maxLinks = DEFAULT_MAX_LINKS } = {}
) {
  let currentUrl = normalizeImportUrl(inputUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    await assertPublicHttpUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/plain, application/octet-stream, application/json;q=0.9, */*;q=0.5',
          'user-agent': 'VPN-Panel-Subscription-Importer/1.0',
        },
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Subscription request timed out');
      throw new Error(`Subscription request failed: ${error?.message || error}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Subscription redirect ${response.status} has no Location header`);
      if (redirect >= maxRedirects) throw new Error('Too many subscription redirects');
      currentUrl = new URL(location, currentUrl);
      continue;
    }
    if (!response.ok) throw new Error(`Subscription server returned HTTP ${response.status}`);

    const body = await readLimitedBody(response, maxBytes);
    const links = extractExternalSubscriptionLinks(body, { maxLinks });
    if (!links.length) {
      throw new Error('Subscription contains no supported VPN links');
    }
    return {
      sourceUrl: currentUrl.toString(),
      links,
      ...summarizeExternalSubscriptionLinks(links),
    };
  }
  throw new Error('Too many subscription redirects');
}

function normalizeImportUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Subscription URL is required');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Subscription URL is invalid');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Only HTTP or HTTPS subscription URLs are allowed');
  }
  if (url.username || url.password) throw new Error('Credentials in subscription URL are not allowed');
  const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (!['80', '443'].includes(effectivePort)) throw new Error('Only ports 80 and 443 are allowed');
  return url;
}

async function assertPublicHttpUrl(url) {
  const hostname = String(url.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Local subscription addresses are not allowed');
  }
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('Subscription hostname did not resolve');
  for (const entry of addresses) {
    if (isPrivateOrReservedIp(entry.address)) {
      throw new Error('Private or reserved subscription addresses are not allowed');
    }
  }
}

function isPrivateOrReservedIp(value) {
  const ip = String(value || '').toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    if (/^f[cd]/.test(ip) || /^fe[89ab]/.test(ip)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
    return mapped ? isPrivateOrReservedIp(mapped) : false;
  }
  return true;
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`Subscription response exceeds ${maxBytes} bytes`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`Subscription response exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodePossibleBase64(value) {
  const compact = String(value || '').replace(/\s+/g, '');
  if (compact.length < 8 || !/^[A-Za-z0-9+/_=-]+$/.test(compact)) return '';
  try {
    const padded = compact.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(compact.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
    return SUPPORTED_LINK.test(decoded) || /\n(?:vless|vmess|ss|trojan|hysteria2|hy2|tuic):\/\//i.test(decoded)
      ? decoded
      : '';
  } catch {
    return '';
  }
}

function collectJsonStrings(value) {
  try {
    const parsed = JSON.parse(value);
    const output = [];
    const visit = (item, depth = 0) => {
      if (depth > 5 || output.length > DEFAULT_MAX_LINKS * 2) return;
      if (typeof item === 'string') output.push(item);
      else if (Array.isArray(item)) item.forEach((child) => visit(child, depth + 1));
      else if (item && typeof item === 'object') Object.values(item).forEach((child) => visit(child, depth + 1));
    };
    visit(parsed);
    return output;
  } catch {
    return [];
  }
}
