#!/usr/bin/env node
import { listServers } from '/app/lib/db-store.js';
const servers = await listServers();
console.log(JSON.stringify(servers.map((server) => ({
  id: String(server.id),
  keys: Object.keys(server).length,
  hasIdentity: Boolean(server.name || server.service || server.host || server.cloudRunProfileId),
})), null, 2));
