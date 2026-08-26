#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { listDealers } from '../lib/auth-store.js';

const dealer = (await listDealers()).find((d) => d.username === 'Joker77');
const users = (await listUsers()).filter((u) => u.dealerId === dealer?.id);
const summary = users.map((u) => ({
  name: u.name,
  id: u.id,
  status: u.status,
  uuid: u.uuid?.slice(0, 8),
  expiresAt: u.expiresAt,
  trafficUsedGB: Number((Number(u.uploadUsedGB||0)+Number(u.downloadUsedGB||u.trafficUsedGB||0)).toFixed(2)),
  trafficLimitGB: u.trafficLimitGB,
  lastTrafficAt: u.lastTrafficAt || null,
  serverCount: (u.serverIds||[]).length,
  hasDisabledGermany10: (u.serverIds||[]).includes('server-25'),
  addressIps: u.addressIps || null,
  disabledReason: u.disabledReason || null,
}));
console.log(JSON.stringify({ dealer: dealer?.username, count: summary.length, users: summary.sort((a,b)=>a.name.localeCompare(b.name)) }, null, 2));
