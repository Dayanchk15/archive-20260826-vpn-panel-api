import { db } from './db-store.js';
import { nowIso } from './dates.js';
import { getSetting, isPostgresEnabled, setSetting } from './postgres.js';

const GLOBAL_DOC = 'settings/globalSubscription';
const PANEL_DOC = 'settings/panel';


const defaultPanel = {
  brandName: process.env.PANEL_BRAND_NAME || 'GGspeed',
  updateIntervalHours: Number(process.env.SUBSCRIPTION_UPDATE_INTERVAL_HOURS || 12),
  addressIps: ['142.251.39.142'],
  // masked = IP из вкладки + configured host
  connectionMode: 'masked',
  importUrlMode: 'api',
  subscriptionBaseUrl: process.env.SUBSCRIPTION_BASE_URL || 'https://sub.twidu.com',
  importClient: 'happ',
  // Info-строки Happ как fake VLESS: www.google.com:80, security=none, ws, path=/.
  includeInfoRowsInStorage: true,
  infoRowHost: process.env.INFO_ROW_HOST || 'www.google.com',
  infoRowPort: Number(process.env.INFO_ROW_PORT || 80),
  // base64 = как tonywaka (тело base64, мета в HTTP-заголовках); plain = текст с #комментариями
  subscriptionBodyFormat: 'base64',
  supportUrl: process.env.PANEL_SUPPORT_URL || '',
  happWarningEnabled: process.env.HAPP_WARNING_ENABLED === '1',
  happWarningText:
    process.env.HAPP_WARNING_TEXT || 'Ping kop gorkezyanem bolsa catylanson dusya',
  happWarningColor: 'green',
  /** Paid happ-proxy.com features (providerid, hide-settings, serverDescription). */
  happProxyEnabled: process.env.HAPP_PROXY_ENABLED === '1',
  /** Happ: block viewing/editing server params in the app (HTTP header + #hide-settings). */
  happHideSettings: process.env.HAPP_HIDE_SETTINGS !== '0',
  /** Happ: issue happ://crypt4/... import links instead of plain https URL. */
  happEncryptedSubscription: process.env.HAPP_ENCRYPTED_SUBSCRIPTION !== '0',
  /** Подпись под названием ноды вместо «VLESS WS TLS». */
  happServerDescription: process.env.HAPP_SERVER_DESCRIPTION || 'Secure',
  /** Happ Provider ID (happ-proxy.com) — optional provider banner in Happ. */
  happProviderId: process.env.HAPP_PROVIDER_ID || '',
  /** Happ FinalMask / DPI: off by default (relay + pool without fragment=). */
  happFragmentationEnabled: process.env.HAPP_FRAGMENTATION_ENABLED === '1',
  happFragmentationLength: process.env.HAPP_FRAGMENTATION_LENGTH || '2',
  happFragmentationInterval: process.env.HAPP_FRAGMENTATION_INTERVAL || '0-1',
  happFragmentationPackets: process.env.HAPP_FRAGMENTATION_PACKETS || 'tlshello',
  /** If true, Happ subscription lists relay lines only. */
  subscriptionRelayOnly: process.env.SUBSCRIPTION_RELAY_ONLY === '1',
  /** Only list minInstances≥1 nodes in Happ subscription (fewer cold-start timeouts). */
  subscriptionWarmOnly: process.env.SUBSCRIPTION_WARM_ONLY !== '0',
  /** Minimum servers in Happ subscription (fills with next priority nodes if needed). */
  subscriptionMinServers: Number(process.env.SUBSCRIPTION_MIN_SERVERS || 7),
  /** If true, at most one server per country before filling to minServers. */
  subscriptionOnePerCountry: process.env.SUBSCRIPTION_ONE_PER_COUNTRY === '1',
  /** Per-user primary relay line. */
  subscriptionTmShardEnabled: process.env.SUBSCRIPTION_TM_SHARD_ENABLED !== '0',
  /** Ready-made VLESS/SS/Hysteria links appended to every user subscription. */
  globalExtraSubscriptionLines: [],
  /** DADA VPN runtime and release controls. Secrets stay in environment variables. */
  mobileAppEnabled: true,
  mobileDiagnosticsEnabled: true,
  mobileApiBaseUrl: process.env.MOBILE_API_BASE_URL || 'https://levospeed.it.com',
  mobileProfileRefreshHours: 12,
  /** DADA-only Xray TLS ClientHello fragmentation. Does not change Happ subscriptions. */
  mobileFragmentationEnabled: process.env.MOBILE_FRAGMENTATION_ENABLED !== '0',
  mobileFragmentationPackets: process.env.MOBILE_FRAGMENTATION_PACKETS || 'tlshello',
  mobileFragmentationLength: process.env.MOBILE_FRAGMENTATION_LENGTH || '2',
  mobileFragmentationInterval: process.env.MOBILE_FRAGMENTATION_INTERVAL || '0-1',
  mobileFragmentationMaxSplit: process.env.MOBILE_FRAGMENTATION_MAX_SPLIT || '3-6',
  mobileProfileRevisionNonce: '',
  mobileServersUpdatedAt: '',
  mobileLatestVersion: Number(process.env.MOBILE_LATEST_VERSION_CODE || 1),
  mobileLatestVersionName: process.env.MOBILE_LATEST_VERSION_NAME || '1.0.0',
  mobileMinimumVersion: Number(process.env.MOBILE_MINIMUM_VERSION_CODE || 1),
  mobileApkUrl: process.env.MOBILE_APK_URL || '',
  mobileApkSha256: process.env.MOBILE_APK_SHA256 || '',
  mobileReleaseSignature: process.env.MOBILE_RELEASE_SIGNATURE || '',
  mobileChangelog: process.env.MOBILE_CHANGELOG || '',
  /** DADA Connect (managed Hiddify Android fork). Kept separate from DADA VPN. */
  hiddifyAndroidEnabled: true,
  hiddifyAndroidApiBaseUrl: process.env.HIDDIFY_ANDROID_API_BASE_URL || 'https://levospeed.it.com',
  hiddifyAndroidProfileRefreshHours: 12,
  hiddifyAndroidFragmentationEnabled: process.env.HIDDIFY_ANDROID_FRAGMENTATION_ENABLED !== '0',
  hiddifyAndroidProfileRevisionNonce: '',
  hiddifyAndroidServersUpdatedAt: '',
  hiddifyAndroidLatestVersion: Number(process.env.HIDDIFY_ANDROID_LATEST_VERSION_CODE || 1),
  hiddifyAndroidLatestVersionName: process.env.HIDDIFY_ANDROID_LATEST_VERSION_NAME || '0.1.0',
  hiddifyAndroidMinimumVersion: Number(process.env.HIDDIFY_ANDROID_MINIMUM_VERSION_CODE || 1),
  hiddifyAndroidApkUrl: process.env.HIDDIFY_ANDROID_APK_URL || '',
  hiddifyAndroidApkSha256: process.env.HIDDIFY_ANDROID_APK_SHA256 || '',
  hiddifyAndroidChangelog: process.env.HIDDIFY_ANDROID_CHANGELOG || '',
};

const defaultGlobal = {
  enabled: true,
  subscriptionMode: 'custom',
  content: '',
  uuid: '',
  serverIds: [],
  profileTitle: '',
  trafficLimitGB: 50,
  trafficUsedGB: 0,
  expiresAt: null,
  updateIntervalHours: 12,
  updatedAt: null,
};

export async function getGlobalSubscription() {
  if (isPostgresEnabled()) {
    const data = await getSetting('globalSubscription');
    return data ? { ...defaultGlobal, ...data } : { ...defaultGlobal };
  }

  const doc = await db.doc(GLOBAL_DOC).get();
  if (!doc.exists) return { ...defaultGlobal };
  return { ...defaultGlobal, ...doc.data() };
}

export async function updateGlobalSubscription(update) {
  const payload = {
    ...update,
    updatedAt: nowIso(),
  };
  if (isPostgresEnabled()) {
    await setSetting('globalSubscription', payload);
    return getGlobalSubscription();
  }

  await db.doc(GLOBAL_DOC).set(payload, { merge: true });
  return getGlobalSubscription();
}

let panelSettingsCache = { at: 0, value: null };
const PANEL_SETTINGS_TTL_MS = Math.max(
  0,
  Number(process.env.PANEL_SETTINGS_CACHE_TTL_MS || 15_000)
);

export function invalidatePanelSettingsCache() {
  panelSettingsCache = { at: 0, value: null };
}

export async function getPanelSettings() {
  if (
    PANEL_SETTINGS_TTL_MS > 0 &&
    panelSettingsCache.value &&
    Date.now() - panelSettingsCache.at < PANEL_SETTINGS_TTL_MS
  ) {
    return panelSettingsCache.value;
  }

  let value;
  if (isPostgresEnabled()) {
    const data = await getSetting('panel');
    value = data ? { ...defaultPanel, ...data } : { ...defaultPanel };
  } else {
    const doc = await db.doc(PANEL_DOC).get();
    value = doc.exists ? { ...defaultPanel, ...doc.data() } : { ...defaultPanel };
  }

  if (PANEL_SETTINGS_TTL_MS > 0) {
    panelSettingsCache = { at: Date.now(), value };
  }
  return value;
}

export async function updatePanelSettings(update) {
  const payload = { ...update, updatedAt: nowIso() };
  invalidatePanelSettingsCache();
  if (isPostgresEnabled()) {
    await setSetting('panel', payload);
    return getPanelSettings();
  }

  await db.doc(PANEL_DOC).set(payload, { merge: true });
  return getPanelSettings();
}
