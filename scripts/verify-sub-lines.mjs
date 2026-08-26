#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';

const users = await listUsers();
const stats = [];
for (const user of users) {
  const body = await buildUserSubscriptionBody({ ...user, serverIds: [] });
  const lines = body.split('\n').filter((l) => l.startsWith('vless://'));
  stats.push({ name: user.name, lines: lines.length, titles: lines.map((l) => l.split('#')[1]?.slice(0, 50)) });
}
const counts = stats.map((s) => s.lines);
console.log(JSON.stringify({
  users: stats.length,
  min: Math.min(...counts),
  max: Math.max(...counts),
  uneven: stats.filter((s) => s.lines !== counts[0]),
  sample: stats.slice(0, 3),
}, null, 2));
