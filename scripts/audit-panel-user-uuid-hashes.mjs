#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { listUsers } from '/app/lib/db-store.js';
import { isUserActive } from '/app/lib/active-users.js';

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const users = (await listUsers(10000)).filter((user) => user.uuid);
console.log(JSON.stringify(users.map((user) => ({
  hash: hash(user.uuid),
  name: user.name,
  active: isUserActive(user),
  status: user.status,
}))));
