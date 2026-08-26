import { buildPublicStorageUrl } from './storage.js';
import { canonicalGoogleDriveUrl, extractDriveFileId, isGoogleDriveUrl } from './google-drive.js';
import { getPanelSettings } from './settings.js';
import { userSubscriptionObjectName } from './subscription-path.js';
import { applyHappImportUrlPolicy, appendProviderIdToSubscriptionUrl, mergeUserHappOverrides } from './happ-subscription-controls.js';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const SUBSCRIPTION_BASE_URL = process.env.SUBSCRIPTION_BASE_URL || '';

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function resolveSubscriptionBaseUrl(settings) {
  const custom = trimTrailingSlash(settings.subscriptionBaseUrl || SUBSCRIPTION_BASE_URL);
  return custom;
}

export async function buildUserSubscriptionUrls({ userId, token, subscriptionFile, panelSettings, user = null }) {
  const settings = panelSettings || (await getPanelSettings());
  const slug = subscriptionFile?.slug || `u-${userId}`;
  const storagePath = subscriptionFile?.storagePath || subscriptionFile?.gcsPath || userSubscriptionObjectName(userId);
  const storageUrlWithToken =
    subscriptionFile?.storageUrlWithToken ||
    subscriptionFile?.storage?.storageUrlWithToken ||
    subscriptionFile?.storage?.storageUrl ||
    subscriptionFile?.storageUrl ||
    buildPublicStorageUrl(storagePath);

  const publicStorageUrl =
    subscriptionFile?.publicStorageUrl ||
    subscriptionFile?.storage?.publicStorageUrl ||
    buildPublicStorageUrl(storagePath);

  const driveFileId =
    subscriptionFile?.driveFileId ||
    extractDriveFileId(publicStorageUrl) ||
    extractDriveFileId(storageUrlWithToken);
  const googleDriveUrl = driveFileId
    ? canonicalGoogleDriveUrl(publicStorageUrl) ||
      canonicalGoogleDriveUrl(storageUrlWithToken) ||
      canonicalGoogleDriveUrl(driveFileId)
    : null;

  const subscriptionBaseUrl = resolveSubscriptionBaseUrl(settings);
  const customDomain = Boolean(subscriptionBaseUrl);

  const panelSubscriptionUrl =
    token && subscriptionBaseUrl ? `${subscriptionBaseUrl}/api/sub/${token}` : null;
  const panelFileUrl = subscriptionBaseUrl ? `${subscriptionBaseUrl}/f/${slug}` : null;
  const panelProxyUrl = panelSubscriptionUrl || panelFileUrl;
  // If this file already has a Google Drive URL, keep that exact URL as the
  // import URL. The Drive file id is stable; only its media is refreshed.
  const stableDriveCandidate = publicStorageUrl || storageUrlWithToken;
  const stableDriveUrl = isGoogleDriveUrl(stableDriveCandidate) ? stableDriveCandidate : null;

  const importUrlMode = settings.importUrlMode || 'api';
  let importUrl = stableDriveUrl || panelSubscriptionUrl || panelFileUrl || publicStorageUrl || storageUrlWithToken;

  if (stableDriveUrl) {
    importUrl = stableDriveUrl;
  } else if (customDomain && (importUrlMode === 'api' || importUrlMode === 'panel')) {
    importUrl = panelSubscriptionUrl || panelFileUrl || importUrl;
  } else {
    importUrl = panelSubscriptionUrl || panelFileUrl || publicStorageUrl || storageUrlWithToken;
  }

  const plainForEncryption = appendProviderIdToSubscriptionUrl(
    panelSubscriptionUrl || panelFileUrl || importUrl,
    settings
  );

  const base = {
    subscriptionUrl: importUrl,
    panelFileUrl,
    panelSubscriptionUrl,
    publicStorageUrl: publicStorageUrl || null,
    googleDriveUrl,
    storageUrlWithToken,
    panelProxyUrl,
    fileUrl: panelFileUrl,
    storageUrl: importUrl,
    storagePath,
    slug,
    importUrlMode,
    subscriptionBaseUrl,
    customDomain,
    panelBlockedInTm: !customDomain,
    importClient: settings.importClient || 'happ',
    plainForEncryption,
    importNote: customDomain
      ? `Основная ссылка: https://${new URL(subscriptionBaseUrl).host}/api/sub/... (ваш домен через Cloudflare).`
      : 'Используется панельный URL подписки через VPS-реестр.',
  };

  return applyHappImportUrlPolicy(base, mergeUserHappOverrides(settings, user));
}

export async function buildUrlsForUser(user, subscriptionFile, panelSettings) {
  const token = String(user.subscriptionToken || '').trim() || null;
  return buildUserSubscriptionUrls({
    userId: user.id,
    token,
    subscriptionFile,
    panelSettings,
    user,
  });
}
