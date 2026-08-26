import { listUsers } from './db-store.js';
import { getTotalUsedGB } from './traffic-usage.js';

export function isUserActive(user, now = Date.now()) {
  if (user.status !== 'active') return false;
  if (!user.uuid) return false;
  const expiresAt = user.expiresAt ? new Date(user.expiresAt).getTime() : null;
  if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= now) return false;
  if (Number(user.trafficLimitGB) > 0 && getTotalUsedGB(user) >= Number(user.trafficLimitGB)) {
    return false;
  }
  return true;
}

export async function getActiveClients() {
  const users = await listUsers();
  return users
    .filter((user) => isUserActive(user))
    .map((user) => ({
      userId: user.id,
      uuid: user.uuid,
      email: user.email || `user-${user.id}`,
      name: user.name || '',
    }));
}

export async function getActiveUuids() {
  return (await getActiveClients()).map((client) => client.uuid);
}
