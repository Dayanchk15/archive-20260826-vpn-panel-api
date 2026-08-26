import { resolveConnectAddressIp, userUsesServerAddressIp } from './address-ips.js';
import {
  resolveHappProxyEnabled,
  resolveHappServerDescription,
} from './happ-subscription-controls.js';
import { resolveHappFragmentationForUser } from './happ-fragmentation.js';
import { buildVlessLink, formatServerRemark } from './vless.js';
import { getEnabledServers, listServers } from './db-store.js';
import {
  getCachedSubscriptionLinks,
  setCachedSubscriptionLinks,
} from './subscription-body-cache.js';
import { getGlobalSubscription, getPanelSettings } from './settings.js';
import { normalizeExtraSubscriptionLines } from './extra-subscription-lines.js';
import { isNewUsersOnlyServer, resolveUserServerIds } from './server-assignment.js';
import { isRelayOnlyUser, isRelaySubscriptionServer } from './relay-subscription.js';
import { sortServersForSubscription, sortServersGroupedByCountry } from './subscription-sort.js';
import {
  dedupeIdsPreserveOrder,
  orderBonusServersByUser,
  primaryBonusServerId,
  tmShardEnabled,
} from './tm-shard.js';
import {
  formatRemarkWithRole,
  loadRelayHealthStore,
  orderServersByHealthAndRole,
} from './relay-health.js';

export { sortServersForSubscription, sortServersGroupedByCountry } from './subscription-sort.js';

/** One node per country — avoids 3× Germany confusing Happ users. */
export function dedupeServersByCountry(servers) {
  const seen = new Set();
  const result = [];
  for (const server of servers) {
    const key = String(server.country || server.service || '')
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(server);
  }
  return result.length ? result : servers;
}

/** Build subscription pool: warm first, fill to subscriptionMinServers from priority list. */
export function selectServersForSubscription(serversAll, panel = {}) {
  const warmOnly = panel.subscriptionWarmOnly !== false;
  const minServers = Math.max(1, Number(panel.subscriptionMinServers ?? 7));
  const onePerCountry = panel.subscriptionOnePerCountry === true;

  let pool = warmOnly
    ? serversAll.filter((s) => Number(s.minInstances ?? 0) >= 1)
    : [];

  const picked = new Set(pool.map((s) => s.id));
  for (const server of serversAll) {
    if (pool.length >= minServers) break;
    if (picked.has(server.id)) continue;
    if (warmOnly && Number(server.minInstances ?? 0) < 1) {
      // allow cold fill only to reach minServers
    }
    pool.push(server);
    picked.add(server.id);
  }

  if (onePerCountry) {
    pool = dedupeServersByCountry(pool);
    const seen = new Set(pool.map((s) => s.id));
    for (const server of serversAll) {
      if (pool.length >= minServers) break;
      if (seen.has(server.id)) continue;
      pool.push(server);
      seen.add(server.id);
    }
  }

  if (!pool.length) return serversAll.slice(0, minServers);
  if (pool.length < minServers) return pool;
  return pool;
}

export function applyUuidPlaceholders(content, uuid) {
  if (!content || !uuid) return content;
  return content.replaceAll('{uuid}', uuid);
}

export async function buildAutoSubscription(user) {
  const panel = await getPanelSettings();
  const [enabledServers, allServers] = await Promise.all([getEnabledServers(), listServers()]);
  const serversById = new Map(allServers.map((server) => [String(server.id), server]));
  const relayOnly = isRelayOnlyUser(user, panel);
  const serverIds = resolveUserServerIds(user, enabledServers);

  const loaded = [];
  for (const serverId of serverIds) {
    const server = serversById.get(String(serverId));
    if (!server || server.enabled === false) continue;
    if (isNewUsersOnlyServer(server)) continue;
    loaded.push(server);
  }

  if (!loaded.length && !relayOnly) {
    for (const server of enabledServers) {
      if (server.enabled === false || isNewUsersOnlyServer(server)) continue;
      loaded.push(server);
    }
  }

  const serversAll = relayOnly ? [] : sortServersForSubscription(loaded);
  const effectiveServers = relayOnly ? [] : selectServersForSubscription(serversAll, panel);
  const healthStore = await loadRelayHealthStore();
  const useHappProxy = resolveHappProxyEnabled(panel);
  const serverDescription = useHappProxy ? resolveHappServerDescription(panel) : '';
  const fragmentation = resolveHappFragmentationForUser(panel, user);

  const links = [];
  let serverIndex = 0;
  const orderedEffective = orderServersByHealthAndRole(effectiveServers, healthStore, panel);
  for (const { server, role } of orderedEffective) {
    const connectAddressIp = resolveConnectAddressIp(user, server, serverIndex, panel);
    links.push(
      buildVlessLink(user, server, {
        connectionMode: panel.connectionMode || 'masked',
        connectAddressIp,
        serverDescription,
        subscriptionRemark: formatServerRemark(server),
        fragmentation,
        panelSettings: panel,
      })
    );
    serverIndex += 1;
  }

  const bonusIdsOrdered = dedupeIdsPreserveOrder(user?.bonusServerIds);
  const pinnedBonusIds = dedupeIdsPreserveOrder(user?.pinnedServerIds);
  const pinnedBonusSet = new Set(pinnedBonusIds.map(String));
  const bonusServers = [];
  for (const bonusId of bonusIdsOrdered) {
    const server = serversById.get(String(bonusId));
    if (!server || server.enabled === false) continue;
    const allowedPinnedRelayOnly =
      server.allowPinnedRelayOnly === true && pinnedBonusSet.has(String(server.id));
    if (relayOnly && !isRelaySubscriptionServer(server) && !allowedPinnedRelayOnly) continue;
    bonusServers.push(server);
  }
  let bonusSorted = orderBonusServersByUser(user, bonusServers, panel);
  if (!bonusSorted.length && bonusServers.length) {
    bonusSorted = sortServersGroupedByCountry(bonusServers);
  }
  if (panel.subscriptionWarmOnly !== false) {
    const warmBonus = bonusSorted.filter((s) => Number(s.minInstances ?? 0) >= 1);
    const pinnedSet = new Set(pinnedBonusIds.map(String));
    if (warmBonus.length) {
      bonusSorted = bonusSorted.filter(
        (server) => Number(server.minInstances ?? 0) >= 1 || pinnedSet.has(String(server.id))
      );
    }
  }
  let orderedBonus = orderServersByHealthAndRole(bonusSorted, healthStore, panel);
  if (pinnedBonusIds.length) {
    const pinOrder = new Map(pinnedBonusIds.map((id, index) => [String(id), index]));
    const pinned = orderedBonus
      .filter(({ server }) => pinOrder.has(String(server.id)))
      .sort(
        (a, b) =>
          pinOrder.get(String(a.server.id)) - pinOrder.get(String(b.server.id))
      );
    const rest = orderedBonus.filter(
      ({ server }) => !pinOrder.has(String(server.id))
    );
    orderedBonus = [...pinned, ...rest];
  }
  for (const { server, role } of orderedBonus) {
    let connectAddressIp = resolveConnectAddressIp(user, server, serverIndex, panel);
    if (
      !userUsesServerAddressIp(user, server) &&
      (server.forceAddressIp || server.dnsTestNode || server.xrayDnsSniffTest)
    ) {
      const fixedIp = String(server.addressIp || '').trim();
      if (fixedIp) connectAddressIp = fixedIp;
    }
    const baseRemark = formatServerRemark(server);
    const isUserPrimary =
      tmShardEnabled(panel) &&
      relayOnly &&
      String(server.id) === String(primaryBonusServerId(user));
    const bonusRemark = server.dnsTestLabel
      ? String(server.dnsTestLabel)
      : server.dnsTestNode || server.xrayDnsSniffTest
        ? `${baseRemark} DNS-TEST`
        : formatRemarkWithRole(baseRemark, role, isUserPrimary);
    links.push(
      buildVlessLink(user, server, {
        connectionMode: panel.connectionMode || 'masked',
        connectAddressIp,
        serverDescription,
        subscriptionRemark: bonusRemark,
        fragmentation,
        panelSettings: panel,
      })
    );
    serverIndex += 1;
  }

  return links.join('\n');
}

export async function buildUserSubscriptionBody(user) {
  const panel = await getPanelSettings();
  const extraLines = normalizeExtraSubscriptionLines([
    ...(Array.isArray(panel.globalExtraSubscriptionLines) ? panel.globalExtraSubscriptionLines : []),
    ...(Array.isArray(user.extraSubscriptionLines) ? user.extraSubscriptionLines : []),
  ]);
  const appendExtraLines = (body) => {
    const base = String(body || '').trim();
    if (!extraLines.length) return base;
    return [base, ...extraLines].filter(Boolean).join('\n');
  };

  if (user.subscriptionMode === 'custom' && user.customSubscriptionContent?.trim()) {
    return appendExtraLines(applyUuidPlaceholders(user.customSubscriptionContent.trim(), user.uuid));
  }

  const cached = getCachedSubscriptionLinks(user?.id);
  if (cached != null) return appendExtraLines(cached);

  const links = await buildAutoSubscription(user);
  setCachedSubscriptionLinks(user?.id, links);
  return appendExtraLines(links);
}

export async function buildGlobalSubscriptionBody() {
  const global = await getGlobalSubscription();
  if (!global.enabled) {
    return { ok: false, reason: 'Global subscription disabled' };
  }

  if (global.content?.trim()) {
    return { ok: true, body: global.content.trim() };
  }

  if (global.subscriptionMode === 'auto' && global.uuid) {
    const pseudoUser = {
      uuid: global.uuid,
      serverIds: global.serverIds?.length ? global.serverIds : [],
    };
    const body = await buildAutoSubscription(pseudoUser);
    return { ok: true, body };
  }

  return { ok: false, reason: 'Global subscription is empty' };
}

export { sendSubscriptionResponse as formatSubscriptionResponse } from './subscription-meta.js';
