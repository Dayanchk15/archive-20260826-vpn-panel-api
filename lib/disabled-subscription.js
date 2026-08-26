import { getEnabledServers, getServerById } from './db-store.js';
import { buildDisabledPlaceholderLink } from './vless.js';
import { resolveUserServerIds } from './server-assignment.js';

export function disabledSubscriptionNotice(user) {
  const reason = user?.disabledReason || 'disabled';
  if (reason === 'expired') return 'Вы были отключены — срок подписки истёк';
  if (reason === 'traffic_exceeded') return 'Вы были отключены — лимит трафика исчерпан';
  return 'Вы были отключены';
}

async function resolveDisabledServers(user) {
  const enabledServers = await getEnabledServers();
  const serverIds = resolveUserServerIds(user, enabledServers);

  const servers = [];
  for (const serverId of serverIds) {
    const server = await getServerById(serverId);
    if (server?.enabled !== false) servers.push(server);
  }
  return servers;
}

export async function buildDisabledSubscriptionBody(user) {
  const lines = [buildDisabledPlaceholderLink({ label: `🚫 ${disabledSubscriptionNotice(user)}` })];
  const servers = await resolveDisabledServers(user);

  for (const server of servers) {
    lines.push(buildDisabledPlaceholderLink({ server }));
  }

  if (lines.length === 1) {
    lines.push(buildDisabledPlaceholderLink({ label: '🚫 Серверы недоступны' }));
  }

  return lines.join('\n');
}
