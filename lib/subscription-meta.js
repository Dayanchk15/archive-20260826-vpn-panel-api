import { getPanelSettings } from './settings.js';
import { buildInfoServerLinks } from './subscription-info-rows.js';
import {
  buildHappWarningBodyLines,
  HAPP_WARNING_EXPOSE_HEADERS,
  applyHappWarningHeaders,
  resolveHappWarning,
} from './happ-warning.js';
import {
  applyHappHideSettingsHeaders,
  buildHideSettingsBodyLine,
  ensureHideSettingsInPlainBody,
  resolveHappHideSettings,
  resolveHappProviderId,
  resolveHappServerDescription,
  shouldIncludeHappInfoRows,
} from './happ-subscription-controls.js';
import { buildProviderIdBodyLine } from './happ-migration.js';
import {
  applyHappFragmentationHeaders,
  buildFragmentationBodyLines,
  HAPP_FRAGMENTATION_EXPOSE_HEADERS,
  resolveHappFragmentation,
} from './happ-fragmentation.js';

const PROFILE_HEADER_RE = /^#profile-(title|update-interval):.*$/gm;
const USERINFO_HEADER_RE = /^#subscription-userinfo:.*$/gm;
const HIDE_SETTINGS_RE = /^#hide-settings:.*$/gm;

export function gbToBytes(value) {
  return Math.max(0, Math.floor(Number(value || 0) * 1024 * 1024 * 1024));
}

export function buildSubscriptionMeta(source, panelSettings = {}) {
  const brandName = panelSettings.brandName || 'GGspeed';
  const updateIntervalHours = Number(
    source.updateIntervalHours || panelSettings.updateIntervalHours || 12
  );

  const trafficLimitGB = Number(source.trafficLimitGB || 0);
  const uploadUsedGB = Number(source.uploadUsedGB || 0);
  const downloadUsedGB =
    source.downloadUsedGB !== undefined && source.downloadUsedGB !== null
      ? Number(source.downloadUsedGB || 0)
      : Number(source.trafficUsedGB || 0);
  const trafficUsedGB = uploadUsedGB + downloadUsedGB || Number(source.trafficUsedGB || 0);
  const uploadBytes = gbToBytes(uploadUsedGB);
  const downloadBytes = gbToBytes(downloadUsedGB);
  const totalBytes = gbToBytes(trafficLimitGB);
  const expireUnix = source.expiresAt
    ? Math.floor(new Date(source.expiresAt).getTime() / 1000)
    : 0;

  return {
    profileTitle: source.profileTitle || source.name || brandName,
    updateIntervalHours,
    upload: uploadBytes,
    download: downloadBytes,
    total: totalBytes,
    expire: expireUnix,
    trafficLimitGB,
    trafficUsedGB,
    uploadUsedGB,
    downloadUsedGB,
    expiresAt: source.expiresAt || null,
    daysRemaining: source.expiresAt
      ? Math.max(0, Math.ceil((new Date(source.expiresAt).getTime() - Date.now()) / 86400000))
      : 0,
  };
}

export function buildSubscriptionUserInfo(meta) {
  return `upload=${meta.upload}; download=${meta.download}; total=${meta.total}; expire=${meta.expire}`;
}

/** Happ: profile-title в HTTP-заголовке — макс. 25 символов. */
export function formatProfileTitle(title) {
  const value = String(title || 'User').trim();
  return value.length > 25 ? value.slice(0, 25) : value;
}

export function formatProfileTitleHeader(title) {
  const formatted = formatProfileTitle(title);
  return `base64:${Buffer.from(formatted, 'utf8').toString('base64')}`;
}

export function stripSubscriptionComments(body) {
  return String(body || '')
    .replace(PROFILE_HEADER_RE, '')
    .replace(USERINFO_HEADER_RE, '')
    .replace(HIDE_SETTINGS_RE, '')
    .replace(/^\s*[\r\n]+/gm, '')
    .trim();
}

/** Только vless/ss строки без #комментариев (как tonywaka внутри base64). */
export function buildVlessOnlyBody(body, meta, options = {}) {
  const links = stripSubscriptionComments(body);
  const parts = [];
  const includeInfoRows =
    options.includeInfoRows ?? shouldIncludeHappInfoRows(options.panelSettings);

  if (includeInfoRows && meta) {
    const infoLines = buildInfoServerLinks(meta, options);
    if (infoLines.length) {
      parts.push(infoLines.join('\n'));
    }
  }

  if (links) {
    parts.push(links);
  }

  return parts.join('\n').trim();
}

export function encodeSubscriptionBody(plainBody) {
  return Buffer.from(String(plainBody || ''), 'utf8').toString('base64');
}

export function isBase64SubscriptionContent(content) {
  const value = String(content || '').trim();
  if (!value) return false;
  if (value.includes('vless://') || value.startsWith('#')) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(value.replace(/\s/g, ''));
}

export function wrapSubscriptionBody(body, meta, options = {}) {
  const vlessBody = buildVlessOnlyBody(body, meta, options);
  const warning = options.happWarning || resolveHappWarning(options.panelSettings);
  const warningLines = buildHappWarningBodyLines(warning);
  const hideSettings = options.hideSettings ?? resolveHappHideSettings(options.panelSettings);
  const hideLine = buildHideSettingsBodyLine(hideSettings);
  const providerLine = buildProviderIdBodyLine(resolveHappProviderId(options.panelSettings));
  const fragmentation =
    options.fragmentation ?? resolveHappFragmentation(options.panelSettings || {});
  const fragmentationLines = buildFragmentationBodyLines(fragmentation);
  const lines = [
    `#profile-title: ${formatProfileTitle(meta.profileTitle)}`,
    ...(providerLine ? [providerLine] : []),
    `#profile-update-interval: ${meta.updateIntervalHours}`,
    `#subscription-userinfo: ${buildSubscriptionUserInfo(meta)}`,
    ...fragmentationLines,
    ...warningLines,
    ...(hideLine ? [hideLine] : []),
    '',
    vlessBody,
  ];

  return lines.join('\n').trim() + '\n';
}

export async function buildMetaForUser(user, extra = {}) {
  const panelSettings = await getPanelSettings();
  const meta = buildSubscriptionMeta(user, panelSettings);
  return {
    ...meta,
    clientUuid: user.uuid || null,
    displayHost: extra.displayHost || panelSettings.addressIps?.[0] || '127.0.0.1',
    displayWsHost: extra.displayWsHost || extra.displayHost || panelSettings.addressIps?.[0] || '127.0.0.1',
    infoRowHost: panelSettings.infoRowHost || 'www.google.com',
    infoRowPort: Number(panelSettings.infoRowPort || 80),
  };
}

function resolveAttachmentFilename(meta, options = {}) {
  const raw = options.filename || meta?.profileTitle || 'subscription';
  const safe = String(raw)
    .trim()
    .replace(/[^\w.\- ]/g, '_')
    .slice(0, 64);
  return safe || 'subscription';
}

export function sendSubscriptionResponse(res, body, meta, format = 'base64', options = {}) {
  const useBase64 = format === 'base64';
  const warning = options.happWarning || resolveHappWarning(options.panelSettings);
  const hideSettings = options.hideSettings ?? resolveHappHideSettings(options.panelSettings);
  const fragmentation =
    options.fragmentation ?? resolveHappFragmentation(options.panelSettings || {});
  let outputBody = body;

  if (!options.rawBody && meta) {
    const wrapOptions = { ...options, happWarning: warning };
    if (useBase64) {
      outputBody = encodeSubscriptionBody(wrapSubscriptionBody(body, meta, wrapOptions));
    } else {
      outputBody = wrapSubscriptionBody(body, meta, wrapOptions);
    }
  }

  const filename = resolveAttachmentFilename(meta, options);

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}.vp"`);
  res.set('Cache-Control', 'no-store');
  res.set('Access-Control-Expose-Headers', HAPP_WARNING_EXPOSE_HEADERS);

  if (meta) {
    res.set('profile-title', formatProfileTitleHeader(meta.profileTitle));
    res.set('profile-update-interval', String(meta.updateIntervalHours));
    res.set('subscription-userinfo', buildSubscriptionUserInfo(meta));
  }

  applyHappWarningHeaders(res, warning);
  applyHappHideSettingsHeaders(res, hideSettings);
  applyHappFragmentationHeaders(res, fragmentation);

  if (options.profileWebPageUrl) {
    res.set('profile-web-page-url', options.profileWebPageUrl);
  }

  if (options.supportUrl) {
    res.set('support-url', options.supportUrl);
  }

  return res.send(outputBody);
}
