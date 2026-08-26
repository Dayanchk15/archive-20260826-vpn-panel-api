import { sha256 } from './crypto.js';
import { resolveConnectAddressIp } from './address-ips.js';
import { getEnabledServers } from './db-store.js';
import { getPanelSettings } from './settings.js';
import { sortServersForSubscription } from './subscription.js';

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

function uniqueServers(servers) {
  const seen = new Set();
  return servers.filter((server) => {
    const id = String(server?.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function hiddifyAndroidCountryCode(server) {
  const explicit = String(
    server?.hiddifyAndroidCountryCode || server?.countryCode || server?.mobileCountryCode || ''
  ).trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(explicit)) return explicit;
  const country = String(server?.country || '').trim().toLowerCase();
  if (COUNTRY_CODES[country]) return COUNTRY_CODES[country];
  const name = String(server?.name || '').toLowerCase();
  for (const [key, code] of Object.entries(COUNTRY_CODES)) {
    if (key.length > 2 && name.includes(key)) return code;
  }
  return 'XX';
}

export function isHiddifyAndroidTransportSupported(server) {
  return (
    String(server?.host || '').trim().length > 0 &&
    String(server?.protocol || 'vless').toLowerCase() === 'vless' &&
    String(server?.network || 'ws').toLowerCase() === 'ws' &&
    String(server?.security || 'tls').toLowerCase() === 'tls'
  );
}

export function isHiddifyAndroidMembershipEnabled(server) {
  if (typeof server?.hiddifyAndroidEnabled === 'boolean') {
    return server.hiddifyAndroidEnabled;
  }
  return server?.mobileEnabled === true;
}

export function isHiddifyAndroidServerSupported(server, appVersionCode = 1) {
  return (
    server?.enabled !== false &&
    isHiddifyAndroidMembershipEnabled(server) &&
    server?.hiddifyAndroidMaintenance !== true &&
    isHiddifyAndroidTransportSupported(server) &&
    Number(server?.hiddifyAndroidMinVersion || 1) <= Math.max(1, Number(appVersionCode || 1))
  );
}

export function buildHiddifyAndroidTransport(server, publicUuid, connectAddressIp, panel = {}) {
  const host = String(server.host || '').trim();
  const address = panel.connectionMode === 'masked' && connectAddressIp
    ? String(connectAddressIp)
    : host;
  return {
    protocol: 'vless',
    uuid: String(publicUuid || '').trim(),
    address,
    port: Number(server.port || 443),
    network: 'ws',
    security: 'tls',
    host,
    path: String(server.path || '/'),
    sni: String(server.sni || 'www.google.com'),
    fingerprint: String(server.fingerprint || 'chrome'),
    alpn: String(server.alpn || 'http/1.1'),
    rejectUdp443: server.rejectUdp443 === true,
  };
}

function refreshAfterSeconds(panel = {}) {
  const hours = Number(panel.hiddifyAndroidProfileRefreshHours ?? 12);
  return Math.max(900, Math.min(7 * 86400, (Number.isFinite(hours) ? hours : 12) * 3600));
}

export function buildHiddifyAndroidProfileFromData(servers, panel = {}, appVersionCode = 1, publicUuid = '') {
  const publicUser = { id: 'hiddify-android-public', uuid: String(publicUuid || '').trim() };
  const candidates = uniqueServers(
    sortServersForSubscription(
      servers
        .filter((server) => server.enabled !== false)
        .filter((server) => isHiddifyAndroidServerSupported(server, appVersionCode))
    )
  );
  const managedServers = candidates.map((server, index) => {
    const countryCode = hiddifyAndroidCountryCode(server);
    const connectAddressIp = resolveConnectAddressIp(publicUser, server, index, panel);
    return {
      id: String(server.id),
      countryCode,
      countryName: String(server.hiddifyAndroidCountryName || COUNTRY_RU[countryCode] || server.country || 'Сервер'),
      displayName: String(server.hiddifyAndroidDisplayName || server.country || server.name || 'Сервер'),
      flag: String(server.flag || ''),
      priority: Number(server.hiddifyAndroidPriority ?? server.sortOrder ?? index + 1),
      transport: buildHiddifyAndroidTransport(server, publicUuid, connectAddressIp, panel),
    };
  });
  managedServers.sort((a, b) => a.priority - b.priority || a.displayName.localeCompare(b.displayName, 'ru'));
  const minimumVersion = Math.max(
    1,
    Number(panel.hiddifyAndroidMinimumVersion || process.env.HIDDIFY_ANDROID_MINIMUM_VERSION_CODE || 1)
  );
  const latestVersion = Math.max(
    minimumVersion,
    Number(panel.hiddifyAndroidLatestVersion || process.env.HIDDIFY_ANDROID_LATEST_VERSION_CODE || 1)
  );
  const profileCore = {
    accessMode: 'public',
    refreshAfterSeconds: refreshAfterSeconds(panel),
    servers: managedServers,
    features: {
      fragmentationEnabled: panel.hiddifyAndroidFragmentationEnabled !== false,
      importsEnabled: false,
    },
    app: { minimumVersion, latestVersion },
  };
  const revision = sha256(JSON.stringify({
    ...profileCore,
    refreshNonce: String(panel.hiddifyAndroidProfileRevisionNonce || ''),
  }));
  return { revision, ...profileCore };
}

export async function buildHiddifyAndroidProfile(appVersionCode = 1, publicUuid = '') {
  const [servers, panel] = await Promise.all([getEnabledServers(), getPanelSettings()]);
  return buildHiddifyAndroidProfileFromData(servers, panel, appVersionCode, publicUuid);
}

export function buildHiddifyAndroidReleaseInfo(panel = {}) {
  return {
    versionCode: Number(panel.hiddifyAndroidLatestVersion || process.env.HIDDIFY_ANDROID_LATEST_VERSION_CODE || 1),
    versionName: String(panel.hiddifyAndroidLatestVersionName || process.env.HIDDIFY_ANDROID_LATEST_VERSION_NAME || '0.1.0'),
    minimumVersionCode: Number(
      panel.hiddifyAndroidMinimumVersion || process.env.HIDDIFY_ANDROID_MINIMUM_VERSION_CODE || 1
    ),
    apkUrl: String(panel.hiddifyAndroidApkUrl || process.env.HIDDIFY_ANDROID_APK_URL || ''),
    sha256: String(panel.hiddifyAndroidApkSha256 || process.env.HIDDIFY_ANDROID_APK_SHA256 || ''),
    changelog: String(panel.hiddifyAndroidChangelog || process.env.HIDDIFY_ANDROID_CHANGELOG || ''),
  };
}
