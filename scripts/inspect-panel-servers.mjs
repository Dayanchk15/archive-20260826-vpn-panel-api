import { listServers } from '/app/lib/db-store.js';
const rows = await listServers();
const out = rows.map((s) => ({
  id: s.id,
  name: s.name,
  enabled: s.enabled,
  address: s.address || s.addressIp || s.host,
  port: s.port,
  network: s.network || s.type,
  security: s.security,
  host: s.host,
  sni: s.sni,
  path: s.path,
  provider: s.provider,
}));
console.log(JSON.stringify(out, null, 2));
