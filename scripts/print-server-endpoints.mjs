import { listServers } from '/app/lib/db-store.js';
const all = await listServers();
for (const s of all) {
  console.log(JSON.stringify({
    id: s.id, service: s.service, name: s.name, enabled: s.enabled !== false,
    region: s.region, addressIp: s.addressIp, host: s.host, port: s.port,
    network: s.network, security: s.security, sni: s.sni, hostHeader: s.hostHeader,
    path: s.path, protocol: s.protocol, cloudRunProfileId: s.cloudRunProfileId,
  }));
}
