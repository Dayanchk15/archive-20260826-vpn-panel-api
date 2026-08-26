#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { buildAutoSubscription } from '../lib/subscription.js';

const users = await listUsers();
const user = users.find((u) => u.enabled !== false) || users[0];
const body = await buildAutoSubscription(user);
const lines = body.split('\n').filter(Boolean).slice(0, 3);
console.log(JSON.stringify({ user: user?.name || user?.id, lines }, null, 2));
