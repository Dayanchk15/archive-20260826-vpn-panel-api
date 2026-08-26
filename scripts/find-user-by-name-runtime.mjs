#!/usr/bin/env node
import { listUsers } from '/app/lib/db-store.js';

const query = String(process.argv[2] || '').trim().toLowerCase();
if (!query) throw new Error('User name query is required');

const users = await listUsers(10000);
const matches = users
  .filter((user) => {
    const text = [
      user.id,
      user.name,
      user.email,
      user.username,
      user.telegramUsername,
    ]
      .map((value) => String(value || '').toLowerCase())
      .join(' ');
    return text.includes(query);
  })
  .map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    bonusServerIds: user.bonusServerIds,
    pinnedServerIds: user.pinnedServerIds,
  }));

console.log(JSON.stringify({ query, count: matches.length, matches }, null, 2));
