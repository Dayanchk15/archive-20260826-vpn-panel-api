#!/usr/bin/env node
/**
 * Panel-only: register relay-eu-* servers + Dayanch bonus lines (relay already deployed).
 *
 *   RELAY_HOST=relay-dayanch-xxxxx-ew.a.run.app node scripts/patch-eu-relay-panel.mjs
 */
import { getServerById, listUsers, updateUser, upsertServer } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { nowIso } from '../lib/dates.js';
import {
  DAYANCH_USER_ID,
  EU_EDGES,
  activeEuEdges,
  PROFILE_ID,
  RELAY_REGION,
  RELAY_SERVICE,
  REMOVED_RELAY_SERVER_IDS,
} from './eu-relay-dayanch/config.mjs';

const relayHost = String(process.env.RELAY_HOST || '').trim();
if (!relayHost) throw new Error('Set RELAY_HOST to relay-dayanch Cloud Run hostname');

const activeIds = String(process.env.ACTIVE_EDGE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const activeEdgeSet = activeIds.length ? new Set(activeIds) : new Set(EU_EDGES.map((e) => e.id));

for (const removedId of REMOVED_RELAY_SERVER_IDS) {
  const old = await getServerById(removedId);
  if (old) {
    await upsertServer(removedId, {
      ...old,
      enabled: false,
      updatedAt: nowIso(),
    });
  }
}

const serverIds = [];
for (const edge of activeEuEdges()) {
  const existing = await getServerById(edge.id);
  const edgeOk = activeEdgeSet.has(edge.id);
  await upsertServer(edge.id, {
    id: edge.id,
    name: edge.name,
    country: edge.country,
    flag: edge.flag,
    host: relayHost,
    service: RELAY_SERVICE,
    cloudRunService: RELAY_SERVICE,
    region: RELAY_REGION,
    cloudRunRegion: RELAY_REGION,
    addressIp: '',
    port: 443,
    protocol: 'vless',
    network: 'ws',
    path: edge.path,
    security: 'tls',
    sni: 'www.google.com',
    fingerprint: 'chrome',
    alpn: 'http/1.1',
    enabled: edgeOk,
    sortOrder: edge.sortOrder,
    cpu: 1,
    memory: '512Mi',
    minInstances: 1,
    maxInstances: 2,
    timeoutSeconds: 3600,
    cloudRunProfileId: PROFILE_ID,
    newUsersOnly: true,
    relayPilot: true,
    externalVps: true,
    relayUpstream: `ws://${edge.ip}:${edge.port}/`,
    relayEdgeNode: edge.node,
    updatedAt: nowIso(),
    createdAt: existing?.createdAt || nowIso(),
  });
  if (edgeOk) serverIds.push(edge.id);
}

const dayanch = (await listUsers()).find((u) => u.id === DAYANCH_USER_ID);
if (!dayanch) throw new Error(`Dayanch not found: ${DAYANCH_USER_ID}`);

const bonusServerIds = [...serverIds, 'glb-vps-1'];
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
      relayHost,
      servers: serverIds,
      dayanch: { id: DAYANCH_USER_ID, lines: lines.length, bonusServerIds },
    },
    null,
    2
  )
);
