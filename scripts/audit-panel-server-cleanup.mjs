#!/usr/bin/env node
import { listServers, listUsers } from '/app/lib/db-store.js';

const servers = await listServers();
const users = await listUsers(5000);
const rows = servers.map((server) => ({
  id: String(server.id),
  name: server.name,
  country: server.country,
  enabled: server.enabled !== false,
  addToNewClients: server.addToNewClients === true,
  newUsersOnly: server.newUsersOnly === true,
  hidden: server.subscriptionHidden === true,
  host: server.host,
  service: server.service,
  assigned: users.filter((user) =>
    [...(user.bonusServerIds || []), ...(user.pinnedServerIds || [])].map(String).includes(String(server.id))
  ).length,
}));
console.log(JSON.stringify({ serverCount: rows.length, userCount: users.length, servers: rows }, null, 2));
