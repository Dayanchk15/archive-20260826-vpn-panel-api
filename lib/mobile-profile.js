import { sha256 } from './crypto.js';
import { resolveConnectAddressIp } from './address-ips.js';
import { getEnabledServers } from './db-store.js';
import { getPanelSettings } from './settings.js';
import { isRelayOnlyUser, isRelaySubscriptionServer } from './relay-subscription.js';
import { resolveUserServerIds } from './server-assignment.js';
import { selectServersForSubscription, sortServersForSubscription } from './subscription.js';
import { getDownloadUsedGB, getTotalUsedGB, getUploadUsedGB } from './traffic-usage.js';

const COUNTRY_CODES = {
  germany: 'DE', deutschland: 'DE', de: 'DE',
  netherlands: 'NL', holland: 'NL', nl: 'NL',
  france: 'FR', fr: 'FR',
  poland: 'PL', pl: 'PL',
  usa: 'US', us: 'US', 'united states': 'US',
  uk: 'GB', gb: 'GB', 'united kingdom': 'GB',
  latvia: 'LV', lv: 'LV',
  singapore: 'SG', sg: 'SG',
  armenia: 'AM', am: 'AM',
  turkey: 'TR', turkiye: 'TR', tr: 'TR',
};

const COUNTRY_RU = {
  DE: 'Германия', NL: 'Нидерланды', FR: 'Франция', PL: 'Польша', US: 'США',
  GB: 'Великобритания', LV: 'Латвия', SG: 'Сингапур', AM: 'Армения', TR: 'Турция',
};

const FLAG_CODES = {
  '🇩🇪': 'DE', '🇳🇱': 'NL', '🇫🇷': 'FR', '🇵🇱': 'PL', '🇺🇸': 'US',
  '🇬🇧': 'GB', '🇱🇻': 'LV', '🇸🇬': 'SG', '🇦🇲': 'AM', '🇹🇷': 'TR',
};

const MOBILE_FRAGMENTATION_MIN_APP_VERSION = 7;

function uniqueServers(servers) {
  const seen = new Set();
  return servers.filter((server) => {
    const id = String(server?.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function countryCodeForServer(server) {
  const explicit = String(server?.mobileCountryCode || server?.countryCode || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(explicit)) return explicit;
  const flag = String(server?.flag || '').trim();
  if (FLAG_CODES[flag]) return FLAG_CODES[flag];
  const country = String(server?.country || '').trim().toLowerCase();
  if (COUNTRY_CODES[country]) return COUNTRY_CODES[country];
  const name = String(server?.name || '').toLowerCase();
  for (const [key, value] of Object.entries(COUNTRY_CODES)) {
    if (key.length > 2 && name.includes(key)) return value;
  }
  return 'XX';
}

export function isMobileServerSupported(server, appVersionCode = 1) {
  const minimumVersion = Number(server?.mobileMinVersion ?? 1);
  return (
    server?.enabled !== false &&
    server?.mobileEnabled === true &&
    server?.mobileMaintenance !== true &&
    String(server?.protocol || 'vless').toLowerCase() === 'vless' &&
    String(server?.network || 'ws').toLowerCase() === 'ws' &&
    String(server?.security || 'tls').toLowerCase() === 'tls' &&
    minimumVersion <= Math.max(1, Number(appVersionCode || 1))
  );
}

export function buildMobileTransport(user, server, connectAddressIp, panel = {}, appVersionCode = 1) {
  const nodeHost = String(server.host || '').trim();
  const connectionMode = panel.connectionMode || 'masked';
  const address = connectionMode === 'masked' && connectAddressIp
    ? String(connectAddressIp)
    : nodeHost;
  const fragmentationSupported = Number(appVersionCode || 1) >= MOBILE_FRAGMENTATION_MIN_APP_VERSION;
  const fragmentationEnabled = fragmentationSupported && panel.mobileFragmentationEnabled !== false;
  return {
    protocol: 'vless',
    uuid: String(user.uuid || ''),
    address,
    port: Number(server.port || 443),
    network: 'ws',
    security: 'tls',
    host: nodeHost,
    path: String(server.path || '/'),
    sni: String(server.sni || 'www.google.com'),
    fingerprint: String(server.fingerprint || 'chrome'),
    alpn: String(server.alpn || 'http/1.1'),
    rejectUdp443: server.rejectUdp443 === true,
    fragmentationEnabled,
    fragmentation: fragmentationEnabled
      ? {
          enabled: true,
          packets: panel.mobileFragmentationPackets || 'tlshello',
          length: panel.mobileFragmentationLength || '2',
          interval: panel.mobileFragmentationInterval || '0-1',
          maxSplit: panel.mobileFragmentationMaxSplit || '3-6',
        }
      : null,
  };
}

function accountState(user) {
  const expiresAtMs = user.expiresAt ? new Date(user.expiresAt).getTime() : null;
  const expired = expiresAtMs !== null && !Number.isNaN(expiresAtMs) && expiresAtMs <= Date.now();
  const totalUsed = getTotalUsedGB(user);
  const limit = Math.max(0, Number(user.trafficLimitGB || 0));
  const overLimit = limit > 0 && totalUsed >= limit;
  const active = user.status === 'active' && !expired && !overLimit && user.mobileAccessEnabled !== false;
  let reason = null;
  if (user.mobileAccessEnabled === false) reason = 'mobile-access-disabled';
  else if (expired || user.disabledReason === 'expired') reason = 'expired';
  else if (overLimit || user.disabledReason === 'traffic-limit') reason = 'traffic-limit';
  else if (user.status !== 'active') reason = user.disabledReason || 'disabled';
  return { active, reason, totalUsed, limit };
}

function mobileRefreshAfterSeconds(panel = {}) {
  const hours = Number(panel.mobileProfileRefreshHours ?? 12);
  return Math.max(900, Math.min(7 * 86400, (Number.isFinite(hours) ? hours : 12) * 3600));
}

export function buildMobileProfileFromData(user, servers, panel = {}, appVersionCode = 1) {
  const state = accountState(user);
  const enabled = servers.filter((server) => server.enabled !== false);
  const relayOnly = isRelayOnlyUser(user, panel);
  const byId = new Map(enabled.map((server) => [String(server.id), server]));

  let primary = [];
  if (!relayOnly) {
    const ids = resolveUserServerIds(user, enabled, panel);
    primary = ids.map((id) => byId.get(String(id))).filter(Boolean);
    primary = selectServersForSubscription(sortServersForSubscription(primary), panel);
  }

  const bonus = (Array.isArray(user.bonusServerIds) ? user.bonusServerIds : [])
    .map((id) => byId.get(String(id)))
    .filter((server) => server && (!relayOnly || isRelaySubscriptionServer(server)));
  const candidates = uniqueServers([...primary, ...bonus])
    .filter((server) => isMobileServerSupported(server, appVersionCode));

  const locations = state.active
    ? candidates.map((server, index) => {
        const code = countryCodeForServer(server);
        const connectAddressIp = resolveConnectAddressIp(user, server, index, panel);
        return {
          id: String(server.id),
          countryCode: code,
          countryName: String(server.mobileCountryName || COUNTRY_RU[code] || server.country || 'Сервер'),
          displayName: String(server.mobileDisplayName || server.country || server.name || 'Сервер'),
          flag: String(server.flag || ''),
          priority: Number(server.mobilePriority ?? server.sortOrder ?? index + 1),
          transport: buildMobileTransport(user, server, connectAddressIp, panel, appVersionCode),
        };
      })
    : [];

  const daysRemaining = user.expiresAt
    ? Math.max(0, Math.ceil((new Date(user.expiresAt).getTime() - Date.now()) / 86400000))
    : null;
  const minimumVersion = Math.max(1, Number(panel.mobileMinimumVersion || process.env.MOBILE_MINIMUM_VERSION_CODE || 1));
  const latestVersion = Math.max(minimumVersion, Number(panel.mobileLatestVersion || process.env.MOBILE_LATEST_VERSION_CODE || 1));
  const profileCore = {
    accessMode: 'user',
    refreshAfterSeconds: mobileRefreshAfterSeconds(panel),
    user: {
      status: state.active ? 'active' : 'disabled',
      reason: state.reason,
      expiresAt: user.expiresAt || null,
      daysRemaining,
      traffic: {
        uploadGB: getUploadUsedGB(user),
        downloadGB: getDownloadUsedGB(user),
        totalGB: state.totalUsed,
        limitGB: state.limit,
      },
    },
    locations,
    app: {
      minimumVersion,
      latestVersion,
    },
  };
  const revisionPayload = {
    ...profileCore,
    refreshNonce: String(panel.mobileProfileRevisionNonce || ''),
  };
  return {
    revision: sha256(JSON.stringify(revisionPayload)),
    ...profileCore,
  };
}

export async function buildMobileProfile(user, appVersionCode = 1) {
  const [servers, panel] = await Promise.all([getEnabledServers(), getPanelSettings()]);
  return buildMobileProfileFromData(user, servers, panel, appVersionCode);
}

export function buildPublicMobileProfileFromData(servers, panel = {}, appVersionCode = 1, publicUuid = '') {
  const publicUser = { id: 'dada-public', uuid: String(publicUuid || '').trim() };
  const candidates = uniqueServers(
    sortServersForSubscription(
      servers
        .filter((server) => server.enabled !== false)
        .filter((server) => isMobileServerSupported(server, appVersionCode))
    )
  );
  const locations = candidates.map((server, index) => {
    const code = countryCodeForServer(server);
    const connectAddressIp = resolveConnectAddressIp(publicUser, server, index, panel);
    return {
      id: String(server.id),
      countryCode: code,
      countryName: String(server.mobileCountryName || COUNTRY_RU[code] || server.country || 'РЎРµСЂРІРµСЂ'),
      displayName: String(server.mobileDisplayName || server.country || server.name || 'РЎРµСЂРІРµСЂ'),
      flag: String(server.flag || ''),
      priority: Number(server.mobilePriority ?? server.sortOrder ?? index + 1),
      transport: buildMobileTransport(publicUser, server, connectAddressIp, panel, appVersionCode),
    };
  });
  const minimumVersion = Math.max(1, Number(panel.mobileMinimumVersion || process.env.MOBILE_MINIMUM_VERSION_CODE || 1));
  const latestVersion = Math.max(minimumVersion, Number(panel.mobileLatestVersion || process.env.MOBILE_LATEST_VERSION_CODE || 1));
  const profileCore = {
    accessMode: 'public',
    refreshAfterSeconds: mobileRefreshAfterSeconds(panel),
    user: {
      status: 'active',
      reason: null,
      expiresAt: null,
      daysRemaining: null,
      traffic: { uploadGB: 0, downloadGB: 0, totalGB: 0, limitGB: 0 },
    },
    locations,
    app: { minimumVersion, latestVersion },
  };
  const revisionPayload = {
    ...profileCore,
    refreshNonce: String(panel.mobileProfileRevisionNonce || ''),
  };
  return { revision: sha256(JSON.stringify(revisionPayload)), ...profileCore };
}

export async function buildPublicMobileProfile(appVersionCode = 1, publicUuid = '') {
  const [servers, panel] = await Promise.all([getEnabledServers(), getPanelSettings()]);
  return buildPublicMobileProfileFromData(servers, panel, appVersionCode, publicUuid);
}

export function buildMobileReleaseInfo(panel = {}) {
  return {
    versionCode: Number(panel.mobileLatestVersion || process.env.MOBILE_LATEST_VERSION_CODE || 1),
    versionName: String(panel.mobileLatestVersionName || process.env.MOBILE_LATEST_VERSION_NAME || '1.0.0'),
    minimumVersionCode: Number(panel.mobileMinimumVersion || process.env.MOBILE_MINIMUM_VERSION_CODE || 1),
    apkUrl: String(panel.mobileApkUrl || process.env.MOBILE_APK_URL || ''),
    sha256: String(panel.mobileApkSha256 || process.env.MOBILE_APK_SHA256 || ''),
    signature: String(panel.mobileReleaseSignature || process.env.MOBILE_RELEASE_SIGNATURE || ''),
    changelog: String(panel.mobileChangelog || process.env.MOBILE_CHANGELOG || ''),
  };
}
