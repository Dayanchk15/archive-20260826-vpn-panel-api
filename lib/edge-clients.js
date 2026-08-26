import { getActiveClients, isUserActive } from './active-users.js';
import { listUsers, getEnabledServers } from './db-store.js';
import { resolveUserServerIds } from './server-assignment.js';
import { getPanelSettings } from './settings.js';

export function publicMobileClient() {
  if (process.env.MOBILE_PUBLIC_ACCESS !== 'true') return null;
  const uuid = String(process.env.MOBILE_PUBLIC_UUID || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) return null;
  return {
    userId: 'dada-public',
    uuid,
    email: 'dada-public@mobile.local',
    name: 'DADA VPN Public',
  };
}

export function publicHiddifyAndroidClient() {
  if (process.env.HIDDIFY_ANDROID_PUBLIC_ACCESS === 'false') return null;
  const uuid = String(process.env.HIDDIFY_ANDROID_PUBLIC_UUID || process.env.MOBILE_PUBLIC_UUID || '')
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) return null;
  return {
    userId: 'hiddify-android-public',
    uuid,
    email: 'dada-connect@mobile.local',
    name: 'DADA Connect Public',
  };
}

function appendPublicMobileClient(clients, seen, server = null, appEnabled = true) {
  if (!appEnabled) return;
  const client = publicMobileClient();
  if (!client || seen.has(client.uuid)) return;
  if (server && server.mobileEnabled !== true) return;
  seen.add(client.uuid);
  clients.push(client);
}

function appendPublicHiddifyAndroidClient(clients, seen, server = null, appEnabled = true) {
  if (!appEnabled) return;
  const client = publicHiddifyAndroidClient();
  if (!client || seen.has(client.uuid)) return;
  if (server && server.hiddifyAndroidEnabled !== true) return;
  seen.add(client.uuid);
  clients.push(client);
}

export async function buildEdgeClientList() {
  const [activeClients, panel] = await Promise.all([getActiveClients(), getPanelSettings()]);
  const seen = new Set();
  const clients = [];

  for (const client of activeClients) {
    const uuid = String(client.uuid || '').trim().toLowerCase();
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    clients.push({
      userId: client.userId,
      uuid,
      email: client.email || `user-${client.userId || uuid.slice(0, 8)}`,
      name: client.name || '',
    });
  }

  appendPublicMobileClient(clients, seen, null, panel.mobileAppEnabled !== false);
  appendPublicHiddifyAndroidClient(clients, seen, null, panel.hiddifyAndroidEnabled !== false);

  return clients;
}

export async function buildEdgeClientListForServer(server) {
  const [enabledServers, users, panel] = await Promise.all([
    getEnabledServers(),
    listUsers(),
    getPanelSettings(),
  ]);
  const seen = new Set();
  const clients = [];
  const serverId = server?.id;

  if (!serverId) return clients;

  for (const user of users) {
    if (!isUserActive(user)) continue;
    const userServerIds = resolveUserServerIds(user, enabledServers);
    if (!userServerIds.includes(serverId)) continue;

    const uuid = String(user.uuid || '').trim().toLowerCase();
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    clients.push({
      userId: user.id,
      uuid,
      email: user.email || `user-${user.id}`,
      name: user.name || '',
    });
  }

  appendPublicMobileClient(clients, seen, server, panel.mobileAppEnabled !== false);
  appendPublicHiddifyAndroidClient(clients, seen, server, panel.hiddifyAndroidEnabled !== false);

  return clients;
}
