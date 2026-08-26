#!/usr/bin/env node
import { getServerById, listUsers } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { DAYANCH_VIP_USER_ID } from '/app/lib/vip-users.js';

const id = 'pilot-fr1-tcp';
const server = await getServerById(id);
const users = await listUsers(5000);
const assigned = users.filter((user) => (user.bonusServerIds || []).map(String).includes(id));
const dayanch = users.find((user) => String(user.id) === String(DAYANCH_VIP_USER_ID));
const body = dayanch ? await buildUserSubscriptionBody(dayanch) : '';

console.log(JSON.stringify({
  server: server && {
    id: server.id,
    enabled: server.enabled,
    host: server.host,
    addressIp: server.addressIp,
    port: server.port,
    network: server.network,
    security: server.security,
  },
  assignedUsers: assigned.length,
  dayanchContainsPilot: body.includes('@185.209.230.14:18443') && body.includes('security=none&type=tcp'),
}, null, 2));
