import { isUserActive } from './active-users.js';
import { buildUserSubscriptionBody } from './subscription.js';
import { buildDisabledSubscriptionBody, disabledSubscriptionNotice } from './disabled-subscription.js';
import {
  buildMetaForUser,
  buildSubscriptionUserInfo,
  encodeSubscriptionBody,
  formatProfileTitleHeader,
  isBase64SubscriptionContent,
  stripSubscriptionComments,
  wrapSubscriptionBody,
} from './subscription-meta.js';
import { getServerById } from './db-store.js';
import { getPanelSettings } from './settings.js';
import {
  HAPP_WARNING_EXPOSE_HEADERS,
  applyHappWarningHeaders,
  mergeHappWarningIntoPlainBody,
  resolveHappWarning,
} from './happ-warning.js';
import {
  applyHappHideSettingsHeaders,
  ensureHideSettingsInPlainBody,
  mergeUserHappOverrides,
  resolveHappHideSettings,
  shouldIncludeHappInfoRows,
} from './happ-subscription-controls.js';
import {
  applyHappFragmentationHeaders,
  ensureFragmentationInPlainBody,
  HAPP_FRAGMENTATION_EXPOSE_HEADERS,
  resolveHappFragmentationForUser,
  stripFragmentationFromPlainBody,
} from './happ-fragmentation.js';
import { applyHappSubscriptionMigration } from './happ-migration.js';
import {
  applyHappAndroidCompatibility,
  applyHappXhttpCompatibility,
  isHappAndroidCompatibilityRequest,
} from './android-subscription-compat.js';
import {
  applyHiddifyFragmentCompatibility,
  isHiddifySubscriptionRequest,
} from './hiddify-subscription-compat.js';

export function inactiveSubscriptionMessage(user) {
  const reason = user?.disabledReason || 'disabled';
  if (reason === 'expired') return 'Subscription expired';
  if (reason === 'traffic_exceeded') return 'Traffic limit exceeded';
  return 'Subscription expired or disabled';
}

async function resolveDisplayEndpoints(user, panel) {
  const serverId = user.serverIds?.[0];
  if (serverId) {
    const server = await getServerById(serverId);
    if (server) {
      return {
        displayHost: server.addressIp || server.host || panel.addressIps?.[0] || '127.0.0.1',
        displayWsHost: server.host || server.addressIp || '127.0.0.1',
      };
    }
  }
  return {
    displayHost: panel.addressIps?.[0] || '127.0.0.1',
    displayWsHost: panel.addressIps?.[0] || '127.0.0.1',
  };
}

export async function serveUserSubscription(res, user, file, format = 'base64', serveOptions = {}) {
  const active = isUserActive(user);
  const panel = await getPanelSettings();
  const hiddifyMode = isHiddifySubscriptionRequest(
    serveOptions.userAgent,
    serveOptions.client
  );
  const panelForUser = mergeUserHappOverrides(panel, user);
  const happWarning = hiddifyMode ? null : resolveHappWarning(panel);
  const hideSettings = hiddifyMode ? null : resolveHappHideSettings(panelForUser);
  // Happ meta `#fragmentation-*` is ignored by Hiddify; per-link hellotls is applied below.
  const fragmentation = hiddifyMode ? null : resolveHappFragmentationForUser(panel, user);
  const endpoints = await resolveDisplayEndpoints(user, panel);
  const meta = await buildMetaForUser(user, endpoints);

  if (!active) {
    meta.expire = 0;
    meta.daysRemaining = 0;
    meta.profileTitle = disabledSubscriptionNotice(user);
  }

  const content = active
    ? serveOptions.live
      ? await buildUserSubscriptionBody(user)
      : String(file?.content || '').trim()
    : await buildDisabledSubscriptionBody(user);

  if (!content) {
    return { ok: false, status: 503, message: 'Subscription file not ready' };
  }

  const bodyOptions = active
    ? {
        includeInfoRows: hiddifyMode ? false : shouldIncludeHappInfoRows(panel),
        infoRowHost: panel.infoRowHost || 'www.google.com',
        infoRowPort: Number(panel.infoRowPort || 80),
        happWarning,
        panelSettings: panelForUser,
        hideSettings,
        fragmentation,
      }
    : {
        includeInfoRows: false,
        happWarning,
        panelSettings: panelForUser,
        hideSettings,
        fragmentation,
      };
  let plainBody;
  if (serveOptions.live) {
    plainBody = wrapSubscriptionBody(content, meta, bodyOptions);
  } else if (isBase64SubscriptionContent(content)) {
    plainBody = mergeHappWarningIntoPlainBody(
      Buffer.from(content, 'base64').toString('utf8'),
      happWarning
    );
  } else {
    plainBody = mergeHappWarningIntoPlainBody(content, happWarning);
  }

  plainBody = ensureHideSettingsInPlainBody(plainBody, hideSettings);
  if (fragmentation) {
    plainBody = ensureFragmentationInPlainBody(plainBody, fragmentation);
  } else {
    plainBody = stripFragmentationFromPlainBody(plainBody);
  }
  if (!hiddifyMode) {
    plainBody = await applyHappSubscriptionMigration(res, user, panel, plainBody);
  }
  if (!hiddifyMode) {
    plainBody = applyHappXhttpCompatibility(plainBody);
  }
  if (!hiddifyMode && isHappAndroidCompatibilityRequest(user, serveOptions.userAgent)) {
    plainBody = applyHappAndroidCompatibility(plainBody);
  }
  if (hiddifyMode) {
    plainBody = applyHiddifyFragmentCompatibility(
      plainBody,
      panel,
      serveOptions.userAgent || ''
    );
  }
  // Happ Android may import through generic/cached fetchers whose User-Agent
  // does not identify Android. Keep this marker in all Happ responses so xHTTP
  // Bunny/Fastly rows are not hidden during import.
  if (!hiddifyMode && !/#no-limit-xhttp-enabled\s*:/i.test(plainBody)) {
    plainBody = `#no-limit-xhttp-enabled: 1\n${plainBody}`;
  }

  if (!plainBody.includes('#profile-title:') && meta) {
    plainBody = wrapSubscriptionBody(stripSubscriptionComments(plainBody), meta, bodyOptions);
  }

  const outputBody =
    format === 'plain'
      ? plainBody
      : encodeSubscriptionBody(plainBody);

  const filename = String(user.name || meta.profileTitle || 'subscription')
    .trim()
    .replace(/[^\w.\- ]/g, '_')
    .slice(0, 64) || 'subscription';

  res.set('Content-Type', 'text/plain; charset=utf-8');
  const disposition = serveOptions.inline ? 'inline' : 'attachment';
  const extension = serveOptions.filenameExtension || (serveOptions.inline ? 'txt' : 'vp');
  res.set('Content-Disposition', `${disposition}; filename="${filename}.${extension}"`);
  // A live subscription must never be served from an intermediary cache after
  // an administrator changes an IP, SNI/HOST, port or RAW key.  Persisted file
  // URLs are rendered live too, so no-store is required for both forms.
  res.set('Cache-Control', serveOptions.live ? 'no-store' : 'private, max-age=20');
  res.set(
    'Access-Control-Expose-Headers',
    `${HAPP_WARNING_EXPOSE_HEADERS}, ${HAPP_FRAGMENTATION_EXPOSE_HEADERS}, no-limit-xhttp-enabled`
  );
  res.set('profile-title', formatProfileTitleHeader(meta.profileTitle));
  res.set('profile-update-interval', String(meta.updateIntervalHours));
  res.set('subscription-userinfo', buildSubscriptionUserInfo(meta));
  applyHappWarningHeaders(res, happWarning);
  if (!hiddifyMode) {
    applyHappHideSettingsHeaders(res, hideSettings);
    applyHappFragmentationHeaders(res, fragmentation);
  }
  if (isHappAndroidCompatibilityRequest(user, serveOptions.userAgent)) {
    try {
      res.set('no-limit-xhttp-enabled', '1');
    } catch (err) {
      console.warn('no-limit-xhttp-enabled header:', err.message);
    }
  }

  if (serveOptions.profileWebPageUrl) {
    res.set('profile-web-page-url', serveOptions.profileWebPageUrl);
  }
  if (serveOptions.supportUrl || panel.supportUrl) {
    res.set('support-url', serveOptions.supportUrl || panel.supportUrl);
  }

  res.send(outputBody);

  return { ok: true, cached: true };
}
