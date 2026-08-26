#!/usr/bin/env node
import { listUsers } from '/app/lib/db-store.js';
import { buildVlessXhttpPilotLink } from '/app/lib/xray-xhttp-edge-config.js';

const userId = String(process.argv[2] || '').trim();
const users = await listUsers();
const user = users.find((u) => u.id === userId) || users.find((u) => u.status === 'active');
if (!user) {
  console.log(JSON.stringify({ error: 'no user' }));
  process.exit(1);
}

const link = buildVlessXhttpPilotLink(user, {
  host: process.env.XHTTP_DOMAIN || 'france2.levospeed.click',
  port: Number(process.env.XHTTP_PORT || 443),
  path: process.env.XHTTP_PATH || '/media/v2/library/sync',
  xhttpHost: process.env.XHTTP_DOMAIN || 'france2.levospeed.click',
  sni: process.env.XHTTP_DOMAIN || 'france2.levospeed.click',
  remark: 'FR2 Fastly xHTTP',
  alpn: 'h3',
});

console.log(JSON.stringify({ userId: user.id, name: user.name, uuid: user.uuid, link }));
