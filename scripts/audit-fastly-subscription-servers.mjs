#!/usr/bin/env node
import { listServers, listUsers } from '../lib/db-store.js';

const servers = await listServers();
const users = (await listUsers(10000)).filter((user) => user.uuid);
const fastly = servers.filter((server) => {
  const text = [server.id, server.name, server.country, server.region, server.fastlyDomain, server.sni]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  return text.includes('fastly') || text.includes('199.232.247.142') || text.includes('199.232.247.140') || text.includes('151.101.');
});

const result = fastly.map((server) => ({
  id: server.id,
  name: server.name,
  country: server.country,
  enabled: server.enabled !== false,
  addressIp: server.addressIp,
  sni: server.sni,
  host: server.host,
  path: server.path,
  alpn: server.alpn,
  mode: server.xhttpMode || server.mode,
  addToNewClients: server.addToNewClients,
  bonusUsers: users.filter((user) => user.bonusServerIds?.includes(server.id)).length,
  pinnedUsers: users.filter((user) => user.pinnedServerIds?.includes(server.id)).length,
}));
console.log(JSON.stringify({ users: users.length, fastlyServers: result }, null, 2));
