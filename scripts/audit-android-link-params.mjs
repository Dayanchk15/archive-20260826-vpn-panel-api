#!/usr/bin/env node
import { getUserById } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';

const user = await getUserById(process.argv[2]);
if (!user) throw new Error('User not found');
const body = await buildUserSubscriptionBody(user);
const rows = body.split(/\r?\n/).filter((line) => line.startsWith('vless://')).map((line) => {
  const parsed = new URL(line);
  const params = Object.fromEntries([...parsed.searchParams.entries()].map(([key, value]) => [
    key,
    key === 'fm' ? `[encoded:${value.length}]` : value,
  ]));
  return {
    name: decodeURIComponent(line.split('#')[1] || ''),
    address: parsed.hostname,
    params,
  };
});
console.log(JSON.stringify({ user: { id: user.id, name: user.name }, rows }, null, 2));
