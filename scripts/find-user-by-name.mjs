#!/usr/bin/env node
import { listUsers } from '/app/lib/db-store.js';

const query = String(process.argv[2] || '').trim().toLowerCase();
if (!query) throw new Error('Name query is required');

const matches = (await listUsers(5000))
  .filter((user) => String(user.name || '').toLowerCase().includes(query))
  .map((user) => ({
    id: user.id,
    name: user.name,
    status: user.status,
    uuid: user.uuid,
  }));

console.log(JSON.stringify(matches));
