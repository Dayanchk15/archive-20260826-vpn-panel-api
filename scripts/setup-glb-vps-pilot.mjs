#!/usr/bin/env node
/**
 * Register GLB+VPS pilot node in panel — does NOT change 7-node pool, addressIps, warm/cold.
 * Adds server with newUsersOnly; optional 8th line via bonusServerIds for one test user.
 *
 * Env:
 *   GLB_HOST          edge.example.com (host + sni)
 *   GLB_IP            frontend IP from create-glb.sh
 *   SERVER_ID         default glb-vps-1
 *   TEST_USER_NAME    optional — user gets bonusServerIds (8th line only for them)
 *   DRY_RUN=1
 */
import { listUsers, listServers, updateUser, upsertServer } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { getPanelSettings } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';

const GLB_HOST = String(process.env.GLB_HOST || '').trim();
const GLB_IP = String(process.env.GLB_IP || '').trim();
const SERVER_ID = String(process.env.SERVER_ID || 'glb-vps-1').trim();
const TEST_USER_NAME = String(process.env.TEST_USER_NAME || '').trim();
const DRY_RUN = process.env.DRY_RUN === '1';

if (!GLB_HOST || !GLB_IP) {
  console.error('Set GLB_HOST and GLB_IP');
  process.exit(1);
}

const panel = await getPanelSettings();
const servers = await listServers();
const existing = servers.find((s) => s.id === SERVER_ID);

const serverDoc = {
  id: SERVER_ID,
  name: process.env.SERVER_NAME || 'GLB Poland',
  country: process.env.SERVER_COUNTRY || 'Poland',
  flag: process.env.SERVER_FLAG || '🇵🇱',
  host: GLB_HOST,
  service: SERVER_ID,
  region: 'external-vps',
  addressIp: GLB_IP,
  port: 443,
  protocol: 'vless',
  network: 'ws',
  path: '/',
  security: 'tls',
  sni: GLB_HOST,
  fingerprint: 'chrome',
  alpn: 'http/1.1',
  enabled: true,
  sortOrder: Number(process.env.SORT_ORDER || 50),
  cpu: 1,
  memory: '512Mi',
  minInstances: 1,
  maxInstances: 1,
  timeoutSeconds: 3600,
  cloudRunProfileId: null,
  newUsersOnly: true,
  glbPilot: true,
  externalVps: true,
  updatedAt: nowIso(),
  createdAt: existing?.createdAt || nowIso(),
};

if (DRY_RUN) {
  console.log(JSON.stringify({ dryRun: true, serverDoc, panelUnchanged: true }, null, 2));
  process.exit(0);
}

await upsertServer(SERVER_ID, serverDoc);

let testUser = null;
if (TEST_USER_NAME) {
  const users = await listUsers();
  testUser = users.find((u) =>
    String(u.name || '')
      .trim()
      .toLowerCase()
      .includes(TEST_USER_NAME.toLowerCase())
  );
  if (!testUser) {
    console.error(`Test user not found: ${TEST_USER_NAME}`);
    process.exit(1);
  }
  const bonusServerIds = [...new Set([...(testUser.bonusServerIds || []), SERVER_ID])];
  await updateUser(testUser.id, { bonusServerIds, updatedAt: nowIso() });
  const fresh = { ...testUser, bonusServerIds };
  await upsertUserSubscriptionFile(fresh);
  const body = await buildAutoSubscription(fresh);
  const lines = body.split('\n').filter((l) => l.startsWith('vless://'));
  console.log(
    JSON.stringify(
      {
        ok: true,
        server: { id: SERVER_ID, host: GLB_HOST, addressIp: GLB_IP },
        testUser: { id: testUser.id, name: testUser.name, lines: lines.length },
        otherClientsUnchanged: true,
        subscriptionMinServers: panel.subscriptionMinServers,
        panelAddressIps: panel.addressIps,
      },
      null,
      2
    )
  );
} else {
  console.log(
    JSON.stringify(
      {
        ok: true,
        server: serverDoc,
        note: 'Server registered with newUsersOnly. Set TEST_USER_NAME to add 8th line for one user.',
      },
      null,
      2
    )
  );
}
