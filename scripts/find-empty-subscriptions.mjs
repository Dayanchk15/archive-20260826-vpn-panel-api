#!/usr/bin/env node
/** Users with empty subscription (only newUsersOnly / missing servers). */
import { listUsers } from '../lib/db-store.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { getEnabledServers, getServerById } from '../lib/db-store.js';
import { isNewUsersOnlyServer } from '../lib/server-assignment.js';

const enabled = await getEnabledServers();
const publicServers = enabled.filter((s) => !isNewUsersOnlyServer(s));

const broken = [];
for (const user of await listUsers()) {
  if (user.status !== 'active') continue;
  const body = await buildAutoSubscription(user);
  if (!String(body || '').trim()) {
    const details = [];
    for (const id of user.serverIds || []) {
      const s = await getServerById(id);
      details.push(
        s
          ? `${s.service}${isNewUsersOnlyServer(s) ? '(hidden)' : ''}`
          : `${id}(missing)`
      );
    }
    broken.push({ name: user.name, id: user.id, servers: details });
  }
}

console.log(
  JSON.stringify(
    {
      publicServerCount: publicServers.length,
      publicServices: publicServers.map((s) => s.service),
      brokenCount: broken.length,
      broken,
    },
    null,
    2
  )
);
