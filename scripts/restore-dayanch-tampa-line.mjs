#!/usr/bin/env node
/** Restore Dayanch 8th line (glb-vps-1 / tampa-relay). Refresh only this user. */
import { listUsers, getServerById, updateUser, upsertServer } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { nowIso } from '../lib/dates.js';

const DAYANCH_ID = process.env.DAYANCH_USER_ID || 'usr_bnjXUy4O1NZufeqW';
const SERVER_ID = process.env.SERVER_ID || 'glb-vps-1';
const RELAY_HOST = String(process.env.RELAY_HOST || 'tampa-relay-phmuswjaga-uc.a.run.app').trim();

const server = await getServerById(SERVER_ID);
if (!server) throw new Error(`Server ${SERVER_ID} not found`);

await upsertServer(SERVER_ID, {
  enabled: true,
  name: process.env.SERVER_NAME || 'Tampa US',
  country: process.env.SERVER_COUNTRY || 'Tampa',
  flag: process.env.SERVER_FLAG || '🇺🇸',
  host: RELAY_HOST,
  service: 'tampa-relay',
  cloudRunService: 'tampa-relay',
  region: 'us-central1',
  cloudRunRegion: 'us-central1',
  addressIp: '',
  sni: 'www.google.com',
  cloudRunProfileId: 'gcp-soppy',
  relayPilot: true,
  externalVps: true,
  glbPilot: false,
  newUsersOnly: true,
  relayUpstream: process.env.UPSTREAM_WS_URL || 'ws://74.115.172.101:8080/',
  updatedAt: nowIso(),
});

const dayanch = (await listUsers()).find((u) => u.id === DAYANCH_ID);
if (!dayanch) throw new Error('Dayanch not found');

const bonusServerIds = [...new Set([...(dayanch.bonusServerIds || []).map(String), SERVER_ID])];
await updateUser(DAYANCH_ID, { bonusServerIds, updatedAt: nowIso() });

const fresh = { ...dayanch, bonusServerIds };
await upsertUserSubscriptionFile(fresh);
const lines = (await buildAutoSubscription(fresh)).split('\n').filter((l) => l.startsWith('vless://'));

console.log(
  JSON.stringify(
    {
      ok: true,
      dayanch: dayanch.name,
      lines: lines.length,
      remark: lines[lines.length - 1]?.match(/#([^?]+)/)?.[1] || '',
      host: RELAY_HOST,
    },
    null,
    2
  )
);
