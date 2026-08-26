#!/usr/bin/env node
import { query } from '../lib/postgres.js';
import { listUsers } from '../lib/db-store.js';
import { listDealers } from '../lib/auth-store.js';

const dealers = await listDealers();
const users = await listUsers(5000);
const perDealer = {};
for (const u of users) {
  const key = u.dealerId || 'owner';
  perDealer[key] = perDealer[key] || [];
  perDealer[key].push({ id: u.id, name: u.name, status: u.status });
}

const owners = await query('SELECT id, username, created_at FROM owners ORDER BY created_at').catch(() => ({ rows: [] }));

console.log(JSON.stringify({
  totalUsers: users.length,
  activeUsers: users.filter((u) => u.status === 'active').length,
  disabledUsers: users.filter((u) => u.status !== 'active').map((u) => ({ name: u.name, status: u.status })),
  dealers: dealers.map((d) => ({
    id: d.id,
    name: d.name,
    username: d.username,
    clientLimit: d.clientLimit,
    userCount: perDealer[d.id]?.length || 0,
    users: perDealer[d.id]?.map((u) => u.name) || [],
  })),
  ownerUsers: perDealer.owner?.length || 0,
  owners: owners.rows,
}, null, 2));
