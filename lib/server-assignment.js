import { getEnabledServers, getEnabledServerIds } from './db-store.js';
import { isRelayOnlyUser } from './relay-subscription.js';

export function isNewUsersOnlyServer(server) {
  return server?.newUsersOnly === true;
}

export function isTmPoolServer(server) {
  return server?.tmPool === true;
}

export function isExcludedFromNewUserAssignment(server) {
  return false;
}

export function resolveUserServerIds(user, enabledServers, panel = null) {
  if (panel && isRelayOnlyUser(user, panel)) return [];
  if (user?.relayOnly === true) return [];
  if (Array.isArray(user?.serverIds) && user.serverIds.length > 0) {
    return user.serverIds;
  }
  const legacy = enabledServers.filter(
    (server) =>
      !isNewUsersOnlyServer(server) &&
      !isTmPoolServer(server) &&
      !isExcludedFromNewUserAssignment(server)
  );
  if (legacy.length) {
    return legacy.map((server) => server.id);
  }
  return enabledServers
    .filter((server) => !isNewUsersOnlyServer(server) && isTmPoolServer(server))
    .map((server) => server.id);
}

export async function resolveEffectiveServerIdsForUser(user) {
  const enabledServers = await getEnabledServers();
  return resolveUserServerIds(user, enabledServers);
}

export async function listAssignableServerIds() {
  return getEnabledServerIds({ forNewUser: true });
}

export async function normalizeAssignableServerIds(serverIds) {
  if (!Array.isArray(serverIds)) return null;
  const assignableIds = new Set(await listAssignableServerIds());
  const resolved = [...new Set(serverIds.map((sid) => String(sid).trim()).filter(Boolean))].filter((sid) =>
    assignableIds.has(sid)
  );
  return resolved.length ? resolved : null;
}
