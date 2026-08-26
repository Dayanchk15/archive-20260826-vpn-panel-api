#!/usr/bin/env node
import { listServers } from '../lib/db-store.js';

const servers = await listServers();
for (const x of servers) {
  const blob = `${x.id} ${x.name} ${x.host || ''} ${x.addressIp || ''}`;
  if (/de3|lv|pl|61\.245|162\.217|gcp2/i.test(blob)) {
    console.log(
      JSON.stringify({
        id: x.id,
        name: x.name,
        host: x.host,
        port: x.port,
        addressIp: x.addressIp,
        enabled: x.enabled,
        gcp2Pool: x.gcp2Pool,
        newUsersOnly: x.newUsersOnly,
      })
    );
  }
}
