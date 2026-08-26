#!/usr/bin/env node
/**
 * Panel-only: point glb-vps-1 at existing tampa-relay host, refresh Dayanch sub.
 * Does NOT deploy GCP or touch other users.
 *
 *   RELAY_HOST=tampa-relay-xxxxx.a.run.app docker exec vpn-panel-api-vps node /app/scripts/patch-glb-vps-relay-panel.mjs
 */
import { getServerById, listUsers, updateUser, upsertServer } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { getPanelSettings } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';

const SERVER_ID = String(process.env.SERVER_ID || 'glb-vps-1').trim();
const RELAY_HOST = String(process.env.RELAY_HOST || '').trim();
const RELAY_SERVICE = String(process.env.RELAY_SERVICE || 'tampa-relay').trim();
const RELAY_REGION = String(process.env.RELAY_REGION || 'us-central1').trim();
const DAYANCH_USER_ID = String(process.env.DAYANCH_USER_ID || 'usr_bnjXUy4O1NZufeqW').trim();
const PROFILE_ID = String(process.env.CLOUD_RUN_PROFILE_ID || 'gcp-soppy').trim();
const UPSTREAM_WS_URL = String(process.env.UPSTREAM_WS_URL || 'ws://74.115.172.101:8080/').trim();

if (!RELAY_HOST) {
  console.error('Set RELAY_HOST=tampa-relay-xxxxx.a.run.app');
  process.exit(1);
}

const panel = await getPanelSettings();
const existing = await getServerById(SERVER_ID);
if (!existing) throw new Error(`Server not found: ${SERVER_ID}`);

await upsertServer(SERVER_ID, {
  name: existing.name || 'US Tampa',
  country: existing.country || 'Poland',
  flag: existing.flag || '🇵🇱',
  host: RELAY_HOST,
  service: RELAY_SERVICE,
  cloudRunService: RELAY_SERVICE,
  region: RELAY_REGION,
  cloudRunRegion: RELAY_REGION,
  addressIp: '',
  port: 443,
  protocol: 'vless',
  network: 'ws',
  path: '/',
  security: 'tls',
  sni: 'www.google.com',
  fingerprint: 'chrome',
  alpn: 'http/1.1',
  enabled: true,
  sortOrder: existing.sortOrder ?? 50,
  cpu: 1,
  memory: '512Mi',
  minInstances: 1,
  maxInstances: 2,
  timeoutSeconds: 3600,
  cloudRunProfileId: PROFILE_ID,
  newUsersOnly: true,
  glbPilot: false,
  relayPilot: true,
  externalVps: true,
  relayUpstream: UPSTREAM_WS_URL,
  updatedAt: nowIso(),
});

const dayanch = (await listUsers()).find((u) => u.id === DAYANCH_USER_ID);
if (!dayanch) throw new Error(`User not found: ${DAYANCH_USER_ID}`);

const bonusServerIds = [...new Set([...(dayanch.bonusServerIds || []).map(String), SERVER_ID])];
if (JSON.stringify(bonusServerIds) !== JSON.stringify(dayanch.bonusServerIds || [])) {
  await updateUser(DAYANCH_USER_ID, { bonusServerIds, updatedAt: nowIso() });
}

const freshUser = { ...dayanch, bonusServerIds };
await upsertUserSubscriptionFile(freshUser);
const lines = (await buildAutoSubscription(freshUser)).split('\n').filter((l) => l.startsWith('vless://'));

console.log(
  JSON.stringify(
    {
      ok: true,
      server: { id: SERVER_ID, host: RELAY_HOST, sni: 'www.google.com', addressIp: panel.addressIps },
      dayanch: { id: DAYANCH_USER_ID, lines: lines.length },
      lastLine: lines[lines.length - 1]?.slice(0, 180),
    },
    null,
    2
  )
);
