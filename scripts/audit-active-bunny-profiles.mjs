#!/usr/bin/env node
import { listServers, listUsers } from '/app/lib/db-store.js';
import { isUserActive } from '/app/lib/active-users.js';

const [servers, users] = await Promise.all([listServers(), listUsers(10000)]);
const bunny = servers.filter((server) => {
  const host = String(server.host || '').toLowerCase();
  const region = String(server.region || '').toLowerCase();
  return host.endsWith('.b-cdn.net') || region.includes('bunny');
});

const usersWithUuid = users.filter((user) => user.uuid);
const summary = bunny.map((server) => {
  const assigned = users.filter((user) =>
    [...(user.serverIds || []), ...(user.bonusServerIds || []), ...(user.pinnedServerIds || [])]
      .map(String)
      .includes(String(server.id))
  );
  return {
    id: server.id,
    enabled: server.enabled !== false,
    host: server.host,
    addressIp: server.addressIp,
    path: server.path,
    country: server.country,
    rejectUdp443: server.rejectUdp443,
    addToNewClients: server.addToNewClients,
    subscriptionEligible: server.subscriptionEligible,
    subscriptionHidden: server.subscriptionHidden,
    assignedUsers: assigned.length,
    missingUsersWithUuid: usersWithUuid.filter((user) =>
      ![...(user.serverIds || []), ...(user.bonusServerIds || []), ...(user.pinnedServerIds || [])]
        .map(String)
        .includes(String(server.id))
    ).length,
  };
});

console.log(JSON.stringify({
  totalUsers: users.length,
  usersWithUuid: usersWithUuid.length,
  activeUsers: users.filter((user) => isUserActive(user)).length,
  total: summary.length,
  profiles: summary,
}, null, 2));
