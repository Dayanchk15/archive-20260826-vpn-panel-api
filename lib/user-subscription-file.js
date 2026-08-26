import { buildUserSubscriptionBody } from './subscription.js';
import { buildDisabledSubscriptionBody } from './disabled-subscription.js';
import {
  wrapSubscriptionBody,
  buildMetaForUser,
} from './subscription-meta.js';
import { getFileByLinkedUserId, createFile, updateFile } from './files.js';
import { getServerById } from './db-store.js';
import { getPanelSettings } from './settings.js';
import { isUserActive } from './active-users.js';
import { resolveHappWarning } from './happ-warning.js';
import { shouldIncludeHappInfoRows, mergeUserHappOverrides, resolveHappHideSettings } from './happ-subscription-controls.js';
import { resolveHappFragmentationForUser } from './happ-fragmentation.js';
import { syncVpnEdgeClientsPhased, resolveWarmServerIds } from './vpn-edge-sync.js';
import { scheduleRelayEdgeSync } from './relay-edge-background-sync.js';
import { userSubscriptionObjectName } from './subscription-path.js';
import { applyHappXhttpCompatibility } from './android-subscription-compat.js';
import { invalidateSubscriptionBodyCache } from './subscription-body-cache.js';

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

export async function upsertUserSubscriptionFile(user) {
  invalidateSubscriptionBodyCache(user?.id);
  const active = isUserActive(user);
  const linksBody = active ? await buildUserSubscriptionBody(user) : await buildDisabledSubscriptionBody(user);
  const panel = await getPanelSettings();
  const panelForUser = mergeUserHappOverrides(panel, user);
  const { displayHost, displayWsHost } = await resolveDisplayEndpoints(user, panel);
  const meta = await buildMetaForUser(user, { displayHost, displayWsHost });
  const rowOptions = {
    includeDisabledNotice: !active,
    includeInfoRows: shouldIncludeHappInfoRows(panelForUser),
    infoRowHost: panel.infoRowHost || 'www.google.com',
    infoRowPort: Number(panel.infoRowPort || 80),
    happWarning: resolveHappWarning(panel),
    panelSettings: panelForUser,
    hideSettings: resolveHappHideSettings(panelForUser),
    fragmentation: resolveHappFragmentationForUser(panel, user),
  };

  // Firebase не может отдать HTTP-заголовки Happ, поэтому храним обычный plain subscription
  // как рабочий global subscription.txt: #metadata + реальные серверы, без fake info-серверов.
  let content = applyHappXhttpCompatibility(wrapSubscriptionBody(linksBody, meta, rowOptions));
  // Stored files can be imported by Happ without an Android User-Agent.
  // Keep xHTTP explicitly enabled so Bunny/Fastly rows are visible on Android.
  if (!/#no-limit-xhttp-enabled\s*:/i.test(content)) {
    content = `#no-limit-xhttp-enabled: 1\n${content}`;
  }

  const slug = `u-${user.id}`;
  // В Туркменистане ссылка вида o/subscriptions%2F... может не открываться.
  // Храним персональные файлы в корне bucket, как рабочий subscription.txt.
  const storagePath = userSubscriptionObjectName(user.id);

  const existing = await getFileByLinkedUserId(user.id);
  let file;
  if (existing) {
    file = await updateFile(existing.id, {
      name: `${user.name || 'Client'} — ${panel.brandName}`,
      content,
      enabled: true,
      publicAccess: true,
      linkedUserId: user.id,
      storagePath,
    });
  } else {
    file = await createFile({
      name: `${user.name || 'Client'} — ${panel.brandName}`,
      slug,
      storagePath,
      content,
      description: `Subscription file for user ${user.id}`,
      type: 'subscription',
      enabled: true,
      publicAccess: true,
      linkedUserId: user.id,
    });
  }

  return file;
}

export async function refreshUserSubscriptionAndEdge(user) {
  const subscriptionFile = await upsertUserSubscriptionFile(user);
  const panel = await getPanelSettings();
  const active = isUserActive(user);
  const serverIds = user.serverIds?.length ? user.serverIds.map(String) : null;
  let vpnEdgeSync;
  if (panel.subscriptionRelayOnly) {
    vpnEdgeSync = {
      ok: true,
      skipped: true,
      message: 'Edge sync skipped (relay-only VPS edges)',
    };
  } else {
    try {
      const warmIds = serverIds ? await resolveWarmServerIds(serverIds) : null;
      vpnEdgeSync = await syncVpnEdgeClientsPhased(
        serverIds ? { serverIds, priorityServerIds: warmIds } : {}
      );
    } catch (syncErr) {
      console.error('VPN edge sync after refresh:', syncErr);
      vpnEdgeSync = { ok: false, error: syncErr.message || String(syncErr) };
    }
  }

  let relayEdgeSync = null;
  try {
    if (panel.subscriptionRelayOnly) {
      if (!active) {
        relayEdgeSync = scheduleRelayEdgeSync({ immediate: true });
      } else {
        relayEdgeSync = scheduleRelayEdgeSync({ immediate: false });
      }
    }
  } catch (relayErr) {
    console.error('Relay edge sync after refresh:', relayErr);
    relayEdgeSync = { ok: false, error: relayErr.message || String(relayErr) };
  }

  return { subscriptionFile, vpnEdgeSync, relayEdgeSync };
}
