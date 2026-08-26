import { listServers } from '/app/lib/db-store.js';
const all = await listServers();
const rows = all.filter((s) => String(s.id).includes('render') || String(s.host || '').includes('akyol') || String(s.host || '').includes('levospeed.online') || String(s.originAddress || '').includes('130.17.12.61'));
console.log(JSON.stringify(rows, null, 2));
