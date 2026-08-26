#!/usr/bin/env node
/**
 * GLB off → Cloud Run relay → Tampa VPS (Dayanch 8th line only).
 * Does NOT change 7-node pool, panel addressIps, cron, or other users' subscriptions.
 *
 * Run inside panel docker:
 *   docker exec vpn-panel-api-vps node /app/scripts/migrate-glb-to-tampa-relay.mjs
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getServerById, listUsers, updateUser, upsertServer } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { deployVpnWsRelay, waitForRelayHost } from '../lib/cloud-run-relay-deploy.js';
import { getPanelSettings } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_ID = String(process.env.SERVER_ID || 'glb-vps-1').trim();
const RELAY_SERVICE = String(process.env.RELAY_SERVICE || 'tampa-relay').trim();
const RELAY_REGION = String(process.env.RELAY_REGION || 'us-central1').trim();
const UPSTREAM_WS_URL = String(process.env.UPSTREAM_WS_URL || 'ws://74.115.172.101:8080/').trim();
const DAYANCH_USER_ID = String(process.env.DAYANCH_USER_ID || 'usr_bnjXUy4O1NZufeqW').trim();
const PROFILE_ID = String(process.env.CLOUD_RUN_PROFILE_ID || 'gcp-soppy').trim();
const TEARDOWN_GLB = process.env.TEARDOWN_GLB !== '0';

const panel = await getPanelSettings();
const existing = await getServerById(SERVER_ID);
if (!existing) throw new Error(`Server not found: ${SERVER_ID}`);

console.log(JSON.stringify({ step: 'deployRelay', service: RELAY_SERVICE, region: RELAY_REGION }));
const deploy = await deployVpnWsRelay(PROFILE_ID, {
  serviceName: RELAY_SERVICE,
  region: RELAY_REGION,
  upstreamWsUrl: UPSTREAM_WS_URL,
  minInstances: 1,
  maxInstances: 2,
});
let host = deploy.host;
if (!host) host = await waitForRelayHost(PROFILE_ID, RELAY_SERVICE, RELAY_REGION);

const serverDoc = {
  id: SERVER_ID,
  name: process.env.SERVER_NAME || existing.name || 'US Tampa',
  country: process.env.SERVER_COUNTRY || existing.country || 'Poland',
  flag: process.env.SERVER_FLAG || existing.flag || '🇵🇱',
  host,
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
  createdAt: existing.createdAt || nowIso(),
};

await upsertServer(SERVER_ID, serverDoc);

const dayanch = (await listUsers()).find((u) => u.id === DAYANCH_USER_ID);
if (!dayanch) throw new Error(`Dayanch user not found: ${DAYANCH_USER_ID}`);

const bonusServerIds = [...new Set([...(dayanch.bonusServerIds || []).map(String), SERVER_ID])];
if (JSON.stringify(bonusServerIds) !== JSON.stringify(dayanch.bonusServerIds || [])) {
  await updateUser(DAYANCH_USER_ID, { bonusServerIds, updatedAt: nowIso() });
}

const freshUser = { ...dayanch, bonusServerIds };
await upsertUserSubscriptionFile(freshUser);
const body = await buildAutoSubscription(freshUser);
const lines = body.split('\n').filter((l) => l.startsWith('vless://'));

let glbTeardown = null;
if (TEARDOWN_GLB) {
  const creds = process.env.GCP_CREDENTIALS || '';
  const teardownScript = path.join(__dirname, 'teardown-glb-vps-pilot-gcp.mjs');
  try {
    const out = execSync(`node "${teardownScript}"`, {
      encoding: 'utf8',
      env: { ...process.env, GCP_CREDENTIALS: creds },
    });
    glbTeardown = JSON.parse(out);
  } catch (err) {
    glbTeardown = { ok: false, error: err.message || String(err) };
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      relay: { service: RELAY_SERVICE, host, region: RELAY_REGION, upstream: UPSTREAM_WS_URL },
      server: {
        id: SERVER_ID,
        host,
        addressIp: '(panel rotation)',
        sni: 'www.google.com',
        cloudRunProfileId: PROFILE_ID,
      },
      dayanch: { id: DAYANCH_USER_ID, name: dayanch.name, lines: lines.length },
      otherClientsUnchanged: true,
      subscriptionMinServers: panel.subscriptionMinServers,
      panelAddressIps: panel.addressIps,
      glbTeardown,
      lastLinePreview: lines[lines.length - 1]?.slice(0, 160),
    },
    null,
    2
  )
);
