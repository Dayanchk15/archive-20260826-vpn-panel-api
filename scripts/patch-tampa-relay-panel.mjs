#!/usr/bin/env node
/** Update glb-vps-1 panel record after tampa-relay scale. */
import { getServerById, upsertServer } from '../lib/db-store.js';
import { nowIso } from '../lib/dates.js';

const SERVER_ID = 'glb-vps-1';
const cpu = Number(process.env.RELAY_CPU || 1);
const memory = String(process.env.RELAY_MEMORY || '1Gi');
const minInstances = Number(process.env.RELAY_MIN || 1);
const maxInstances = Number(process.env.RELAY_MAX || 2);

const existing = await getServerById(SERVER_ID);
if (!existing) throw new Error(`Server ${SERVER_ID} not found`);

await upsertServer(SERVER_ID, {
  ...existing,
  cpu,
  memory,
  minInstances,
  maxInstances,
  updatedAt: nowIso(),
});

console.log(JSON.stringify({ ok: true, id: SERVER_ID, cpu, memory, minInstances, maxInstances }, null, 2));
