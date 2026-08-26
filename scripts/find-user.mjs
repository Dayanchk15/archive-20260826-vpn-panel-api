#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
const uuid = process.argv[2];
const name = process.argv[3];
const users = await listUsers(5000);
if (uuid) {
  const u = users.find((x) => String(x.uuid).toLowerCase() === uuid.toLowerCase());
  console.log(JSON.stringify(u ? { id: u.id, name: u.name, dealerId: u.dealerId, status: u.status } : { found: false }));
} else if (name) {
  const hits = users.filter((x) => String(x.name || '').toLowerCase().includes(String(name).toLowerCase()));
  console.log(JSON.stringify(hits.map((u) => ({ id: u.id, name: u.name, dealerId: u.dealerId })), null, 2));
} else {
  console.log(JSON.stringify(users.filter((u) => u.dealerId).map((u) => u.name).sort()));
}
