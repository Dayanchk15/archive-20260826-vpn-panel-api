import { getUserById, listServers } from '/app/lib/db-store.js';
import { readFile } from 'node:fs/promises';
const id = 'usr_bnjXUy4O1NZufeqW';
const user = await getUserById(id);
const servers = await listServers();
let mapProbe = null;
try {
  const map = JSON.parse(await readFile('/opt/vpn-panel-api-vps/scripts/vps-bundle-links.json', 'utf8'));
  const row = (map.links || []).find((x) => String(x.userId) === id);
  mapProbe = { server: map.server, ssPort: row?.ssPort || null, vless: (row?.vlessLinks || []).map((x) => { const link = String(x.link); return { egress: x.egress, port: (link.match(/:([0-9]+)\\?/) || [])[1] || null, security: (link.match(/security=([^&]+)/) || [])[1] || null, type: (link.match(/type=([^&]+)/) || [])[1] || null }; }) };
} catch {}
const lines = Array.isArray(user?.extraSubscriptionLines) ? user.extraSubscriptionLines.map(String) : [];
const safeLines = lines.map((line) => {
  const value = decodeURIComponent(line);
  const at = value.indexOf('@');
  const hash = value.indexOf('#');
  const queryStart = value.indexOf('?', at);
  const queryEnd = hash > queryStart ? hash : value.length;
  const query = new URLSearchParams(queryStart > 0 ? value.slice(queryStart + 1, queryEnd) : '');
  const scheme = value.slice(0, value.indexOf('://'));
  const ssPayload = scheme === 'ss' && at > 0 ? value.slice(value.indexOf('://') + 3, at) : '';
  let ssMethod = null; let ssPasswordLength = null;
  if (ssPayload) { try { const decoded = Buffer.from(ssPayload, 'base64url').toString('utf8'); const split = decoded.indexOf(':'); ssMethod = split > 0 ? decoded.slice(0, split) : null; ssPasswordLength = split > 0 ? decoded.slice(split + 1).length : null; } catch {} }
  return { scheme, endpoint: at > 0 ? value.slice(at + 1, queryStart > 0 ? queryStart : hash > 0 ? hash : value.length) : null, label: hash > 0 ? value.slice(hash + 1) : '', type: query.get('type'), security: query.get('security'), sni: query.get('sni'), host: query.get('host'), path: query.get('path'), alpn: query.get('alpn'), method: query.get('method'), ssMethod, ssPasswordLength };
});
console.log(JSON.stringify({
  found: Boolean(user), id,
  name: user?.name || null,
  status: user?.status || null,
  uuidPresent: Boolean(user?.uuid),
  serverIds: user?.serverIds || [],
  lineCount: lines.length,
  lines: safeLines,
  servers: servers.filter((s) => (user?.serverIds || []).map(String).includes(String(s.id))).map((s) => ({ id: s.id, enabled: s.enabled, address: s.address || s.addressIp || s.host, port: s.port, network: s.network || s.type, security: s.security, host: s.host, sni: s.sni, path: s.path }))
  , mapProbe
}, null, 2));
