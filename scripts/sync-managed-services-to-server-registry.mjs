import { listManagedServers, getOutlineInstance } from '../lib/managed-servers.js';
import { listManagedXrayTunnels } from '../lib/managed-xray.js';
import { publishManagedOutlineServer, publishManagedXrayServer } from '../lib/managed-server-registry.js';

const servers = await listManagedServers();
let outline = 0;
let xray = 0;
for (const server of servers) {
  if (await getOutlineInstance(server.id)) {
    await publishManagedOutlineServer(server);
    outline += 1;
  }
  for (const tunnel of await listManagedXrayTunnels(server.id)) {
    await publishManagedXrayServer(server, tunnel);
    xray += 1;
  }
}
console.log(JSON.stringify({ ok: true, servers: servers.length, outline, xray }));
