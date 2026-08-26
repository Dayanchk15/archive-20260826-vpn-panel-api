const HAPP_CRYPTO_API = 'https://crypto.happ.su/api-v2.php';
const CRYPTO_CACHE_MS = 60 * 60 * 1000;

const cryptoCache = new Map();

/** Paid happ-proxy features (providerid, serverDescription, hide-settings). */
export function resolveHappProxyEnabled(panelSettings = {}) {
  if (panelSettings.happProxyEnabled === false) return false;
  if (process.env.HAPP_PROXY_ENABLED === '0') return false;
  return panelSettings.happProxyEnabled === true;
}

export function resolveHappHideSettings(panelSettings = {}) {
  if (!resolveHappProxyEnabled(panelSettings)) return false;
  if (panelSettings.happHideSettings === false) return false;
  return true;
}

export function resolveHappProviderId(panelSettings = {}) {
  if (!resolveHappProxyEnabled(panelSettings)) return '';
  return String(panelSettings.happProviderId ?? process.env.HAPP_PROVIDER_ID ?? '').trim();
}

/** Happ: providerid в URL подписки (#?providerid=…) — нужен для serverDescription. */
export function appendProviderIdToSubscriptionUrl(url, panelSettings = {}) {
  const base = String(url || '').trim();
  const providerId = resolveHappProviderId(panelSettings);
  if (!base || !providerId || /providerid=/i.test(base)) return base;
  const withoutHash = base.split('#')[0];
  return `${withoutHash}#?providerid=${encodeURIComponent(providerId)}`;
}

export function resolveHappServerDescription(panelSettings = {}) {
  if (!resolveHappProxyEnabled(panelSettings)) return '';
  const brand = String(panelSettings.brandName || '').trim();
  const custom = String(panelSettings.happServerDescription || '').trim();
  if (custom) return custom;
  return brand || 'Secure';
}

export function shouldIncludeHappInfoRows(panelSettings = {}) {
  if (panelSettings.includeInfoRowsInStorage === false) return false;
  if (resolveHappHideSettings(panelSettings)) return false;
  return true;
}

export function resolveHappEncryptedSubscription(panelSettings = {}) {
  if (!resolveHappProxyEnabled(panelSettings)) return false;
  if (panelSettings.happEncryptedSubscription === false) return false;
  return true;
}

/** Per-user Happ privacy overrides without changing panel defaults for everyone else. */
export function mergeUserHappOverrides(panelSettings = {}, user = null) {
  if (!user) return panelSettings;
  const merged = { ...panelSettings };
  if (user.happHideSettings === false || user.happHideSettings === true) {
    merged.happHideSettings = user.happHideSettings;
  }
  if (user.happEncryptedSubscription === false || user.happEncryptedSubscription === true) {
    merged.happEncryptedSubscription = user.happEncryptedSubscription;
  }
  return merged;
}

export function resolveHappHideSettingsForUser(user, panelSettings = {}) {
  return resolveHappHideSettings(mergeUserHappOverrides(panelSettings, user));
}

export function ensureHideSettingsInPlainBody(plainBody, enabled = true) {
  const body = String(plainBody || '');
  if (!enabled || body.includes('#hide-settings:')) return body;
  const lines = body.split('\n');
  const userInfoIdx = lines.findIndex((line) => line.startsWith('#subscription-userinfo:'));
  if (userInfoIdx >= 0) {
    lines.splice(userInfoIdx + 1, 0, '#hide-settings: 1');
    return `${lines.join('\n').trim()}\n`;
  }
  return `#hide-settings: 1\n${body.trim()}\n`;
}

export function buildHideSettingsBodyLine(enabled = true) {
  if (!enabled) return null;
  return '#hide-settings: 1';
}

export function applyHappHideSettingsHeaders(res, enabled = true) {
  if (!res || !enabled) return;
  try {
    res.set('hide-settings', '1');
    res.set('Hide-Settings', '1');
  } catch (err) {
    console.warn('hide-settings header:', err.message);
  }
}

function parseHappApiResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.startsWith('happ://')) return raw;
  try {
    const parsed = JSON.parse(raw);
    return (
      parsed.encrypted_link ||
      parsed.encryptedLink ||
      parsed.link ||
      parsed.url ||
      null
    );
  } catch {
    return null;
  }
}

async function encryptViaHappApi(subscriptionUrl) {
  const res = await fetch(HAPP_CRYPTO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: subscriptionUrl }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`Happ crypto API HTTP ${res.status}`);
  }
  const link = parseHappApiResponse(await res.text());
  if (!link || !String(link).startsWith('happ://')) {
    throw new Error('Happ crypto API returned invalid link');
  }
  return link;
}

function encryptViaLocalLibrary(subscriptionUrl) {
  return import('@kastov/cryptohapp').then(({ createHappCryptoLink }) => {
    const version = 'v4';
    return createHappCryptoLink(subscriptionUrl, version, true);
  });
}

/** Encrypt subscription import URL for Happ (happ://crypt4/... or crypt5 from API). */
export async function buildHappEncryptedImportLink(subscriptionUrl, panelSettings = {}) {
  const plainUrl = appendProviderIdToSubscriptionUrl(
    String(subscriptionUrl || '').trim(),
    panelSettings
  );
  if (!plainUrl || !resolveHappEncryptedSubscription(panelSettings)) {
    return null;
  }

  const cached = cryptoCache.get(plainUrl);
  if (cached && Date.now() - cached.at < CRYPTO_CACHE_MS) {
    return cached.link;
  }

  let link = null;
  try {
    link = await encryptViaLocalLibrary(plainUrl);
  } catch (err) {
    console.warn('happ crypto local:', err.message);
  }

  if (!link) {
    try {
      link = await encryptViaHappApi(plainUrl);
    } catch (err) {
      console.warn('happ crypto api:', err.message);
    }
  }

  if (!link) return null;
  cryptoCache.set(plainUrl, { link, at: Date.now() });
  return link;
}

export async function applyHappImportUrlPolicy(urls, panelSettings = {}) {
  const plainSubscriptionUrl =
    urls.plainForEncryption || urls.panelSubscriptionUrl || urls.subscriptionUrl || null;
  if (!plainSubscriptionUrl) {
    return { ...urls, plainSubscriptionUrl: null, happEncryptedUrl: null };
  }

  const happEncryptedUrl = await buildHappEncryptedImportLink(plainSubscriptionUrl, panelSettings);
  if (!happEncryptedUrl) {
    return { ...urls, plainSubscriptionUrl, happEncryptedUrl: null };
  }

  return {
    ...urls,
    plainSubscriptionUrl,
    happEncryptedUrl,
    subscriptionUrl: happEncryptedUrl,
    storageUrl: happEncryptedUrl,
    importNote:
      'Happ: зашифрованная ссылка happ://crypt… — настройки серверов скрыты. Обновление подписки через Happ.',
  };
}
