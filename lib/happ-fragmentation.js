/**
 * Happ subscription fragmentation (FinalMask / DPI bypass).
 * Docs: https://www.happ.su/main/dev-docs/app-management
 * Competitor preset: length=2, delay=0-1, packets=tlshello
 */

import { isDayanchVipUser } from './vip-users.js';

const DEFAULT_FRAGMENTATION = {
  enabled: true,
  length: '2',
  interval: '0-1',
  packets: 'tlshello',
};

export function resolveHappFragmentation(panelSettings = {}) {
  if (panelSettings.happFragmentationEnabled === false) return null;
  if (process.env.HAPP_FRAGMENTATION_ENABLED === '0') return null;

  return {
    enabled: true,
    length: String(
      panelSettings.happFragmentationLength ||
        process.env.HAPP_FRAGMENTATION_LENGTH ||
        DEFAULT_FRAGMENTATION.length
    ).trim(),
    interval: String(
      panelSettings.happFragmentationInterval ||
        process.env.HAPP_FRAGMENTATION_INTERVAL ||
        DEFAULT_FRAGMENTATION.interval
    ).trim(),
    packets: String(
      panelSettings.happFragmentationPackets ||
        process.env.HAPP_FRAGMENTATION_PACKETS ||
        DEFAULT_FRAGMENTATION.packets
    ).trim(),
  };
}

/** Panel fragmentation unless user opts out (Dayanch VIP: no fragment block). */
export function resolveHappFragmentationForUser(panelSettings = {}, user = null) {
  if (isDayanchVipUser(user)) return null;
  return resolveHappFragmentation(panelSettings);
}

function stripFragmentFromVlessLine(line) {
  if (!line.startsWith('vless://')) return line;
  // CDN profiles can carry an explicit server-scoped legacy fragment preset.
  // Preserve it when subscription-wide fragmentation is disabled; the cleanup
  // below is only meant to remove cached global fragmentation from other rows.
  try {
    const parsed = new URL(line);
    const host = String(parsed.searchParams.get('host') || '').toLowerCase();
    const serverScopedCdn = host.endsWith('.b-cdn.net') || host.endsWith('.levospeed.click');
    if (serverScopedCdn && parsed.searchParams.has('fragment')) return line;
  } catch {
    // Fall through to the conservative string cleanup for malformed rows.
  }
  const hashIdx = line.indexOf('#');
  const hash = hashIdx >= 0 ? line.slice(hashIdx) : '';
  const beforeHash = hashIdx >= 0 ? line.slice(0, hashIdx) : line;
  const qIdx = beforeHash.indexOf('?');
  if (qIdx < 0) return line;
  const base = beforeHash.slice(0, qIdx);
  const query = beforeHash.slice(qIdx + 1);
  const params = query
    .split('&')
    .filter((part) => part && !part.toLowerCase().startsWith('fragment='));
  const qs = params.join('&');
  return `${qs ? `${base}?${qs}` : base}${hash}`;
}

/** Remove #fragmentation-* rows and fragment= from vless links (cached subs). */
export function stripFragmentationFromPlainBody(plainBody) {
  const lines = String(plainBody || '')
    .split('\n')
    .filter((line) => !line.startsWith('#fragmentation-'))
    .map(stripFragmentFromVlessLine);
  const body = lines.join('\n').trim();
  return body ? `${body}\n` : '';
}

/** Per-server VLESS query: fragment=length,interval,packets */
export function buildVlessFragmentQueryParam(fragmentation, options = {}) {
  if (!fragmentation?.enabled) return '';
  const { length, interval, packets } = fragmentation;
  if (!length || !interval || !packets) return '';
  const value = `${length},${interval},${packets}`;
  return `fragment=${options.literal === true ? value : encodeURIComponent(value)}`;
}

export function buildFragmentationBodyLines(fragmentation) {
  if (!fragmentation?.enabled) return [];
  return [
    '#fragmentation-enable: 1',
    `#fragmentation-packets: ${fragmentation.packets}`,
    `#fragmentation-length: ${fragmentation.length}`,
    `#fragmentation-interval: ${fragmentation.interval}`,
  ];
}

export function ensureFragmentationInPlainBody(plainBody, fragmentation) {
  const body = String(plainBody || '');
  const lines = buildFragmentationBodyLines(fragmentation);
  if (!lines.length || body.includes('#fragmentation-enable')) return body;

  const split = body.split('\n');
  const userInfoIdx = split.findIndex((line) => line.startsWith('#subscription-userinfo:'));
  if (userInfoIdx >= 0) {
    split.splice(userInfoIdx + 1, 0, ...lines);
    return `${split.join('\n').trim()}\n`;
  }
  return `${lines.join('\n')}\n${body.trim()}\n`;
}

export function applyHappFragmentationHeaders(res, fragmentation) {
  if (!res || !fragmentation?.enabled) return;
  try {
    res.set('fragmentation-enable', '1');
    res.set('fragmentation-packets', fragmentation.packets);
    res.set('fragmentation-length', fragmentation.length);
    res.set('fragmentation-interval', fragmentation.interval);
  } catch (err) {
    console.warn('fragmentation headers:', err.message);
  }
}

export const HAPP_FRAGMENTATION_EXPOSE_HEADERS =
  'fragmentation-enable, fragmentation-packets, fragmentation-length, fragmentation-interval';
