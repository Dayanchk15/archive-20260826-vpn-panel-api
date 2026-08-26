import { getEnabledServers } from './db-store.js';
import { getPanelSettings } from './settings.js';
import { isDayanchVipUser } from './vip-users.js';
import { sortServersGroupedByCountry } from './subscription-sort.js';
import {
  dedupeIdsPreserveOrder,
  resolveShardPoolFromAvailable,
  resolveTmBonusServerIds,
} from './tm-shard.js';

/** Managed relay pool. */
export function isRelaySubscriptionServer(server) {
  if (server?.subscriptionEligible === true) return true;
  if (server?.addToNewClients === true) return true;
  const id = String(server?.id || '').trim();
  if (id === 'glb-vps-1' || id.startsWith('relay-eu-')) return true;
  const svc = String(server?.service || '').trim();
  return (
    svc === 'relay-dayanch' ||
    svc === 'tampa-relay' ||
    svc.startsWith('relay-eu-') ||
    false
  );
}

export function shouldAutoAssignRelayServer(server) {
  return server?.addToNewClients !== false && isRelaySubscriptionServer(server);
}

export function isRelayOnlyUser(user, panel = {}) {
  if (isDayanchVipUser(user)) return true;
  if (user?.relayOnly === true) return true;
  if (panel?.subscriptionRelayOnly === true) return true;
  return false;
}

export async function listEnabledRelayServerIds(options = {}) {
  const servers = await getEnabledServers();
  const ids = servers
    .filter(
      (s) =>
        s.enabled !== false &&
        shouldAutoAssignRelayServer(s)
    )
    .map((s) => String(s.id));
  if (options.tmShardOrder) {
    return resolveShardPoolFromAvailable(ids);
  }
  return sortServersGroupedByCountry(
    servers.filter(
      (s) =>
        s.enabled !== false &&
        shouldAutoAssignRelayServer(s)
    )
  ).map((s) => String(s.id));
}

/** New users in relay-only mode need bonus lines; otherwise subscription body is empty. */
export async function applyRelayUserDefaults(userDoc, panel = null) {
  const settings = panel ?? (await getPanelSettings());
  if (!settings.subscriptionRelayOnly && userDoc.relayOnly !== true) {
    return userDoc;
  }
  const relayIds = await listEnabledRelayServerIds({ tmShardOrder: true });
  if (!relayIds.length) return userDoc;
  const countryOrderedIds = await listEnabledRelayServerIds();
  const bonusServerIds = dedupeIdsPreserveOrder(
    resolveTmBonusServerIds(userDoc, relayIds, settings)
  );
  return {
    ...userDoc,
    bonusServerIds,
    pinnedServerIds: countryOrderedIds.filter((id) => bonusServerIds.includes(id)),
    relayOnly: true,
    serverIds: [],
  };
}
