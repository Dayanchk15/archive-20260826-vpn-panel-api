#!/usr/bin/env node
import { listServers, listUsers, upsertServer } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { getPanelSettings } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';

const DRY_RUN = process.env.DRY_RUN === '1';
const ALLOW_DAYANCH_CHANGE = process.env.ALLOW_DAYANCH_CHANGE === '1';
const DAYANCH_VIP_USER_ID = 'usr_bnjXUy4O1NZufeqW';

const definitions = [
  {
    id: 'pilot-tampa-reality',
    name: 'Tampa',
    country: 'USA, Tampa',
    flag: '🇺🇸 ⭐',
    sortOrder: -300,
    host: '74.115.172.101',
    addressIp: '74.115.172.101',
    port: 9443,
    protocol: 'vless',
    network: 'tcp',
    security: 'reality',
    sni: 'www.google.com',
    fingerprint: 'chrome',
    flow: 'xtls-rprx-vision',
    realityPublicKey: 'QgGaAFzInkaOcryF3kbeBkwd7Y4W2e4bJad3mZwNnQA',
    realityShortId: 'c0c2f4514177c493',
    spiderX: '/',
  },
  {
    id: 'pilot-fornex-reality',
    name: 'Fornex',
    country: 'DE, Frankfurt',
    flag: '🇩🇪 ⭐',
    sortOrder: -299,
    host: '130.17.12.61',
    addressIp: '130.17.12.61',
    port: 443,
    protocol: 'vless',
    network: 'tcp',
    security: 'reality',
    sni: 'www.google.com',
    fingerprint: 'chrome',
    flow: 'xtls-rprx-vision',
    realityPublicKey: 'Mu5fEixBjouW09Lzo7jscJhld3XklXv8WMaIz0Q8Kxg',
    realityShortId: '744668bdbfd80ce3',
    spiderX: '/',
  },
  {
    id: 'pilot-fr1-tcp',
    name: 'FR1',
    country: 'FR1, Paris',
    flag: '🇫🇷 ⭐',
    sortOrder: -298,
    host: '185.209.230.14',
    addressIp: '185.209.230.14',
    port: 18443,
    protocol: 'vless',
    network: 'tcp',
    security: 'none',
  },
];

const panelBefore = await getPanelSettings();
const users = await listUsers();
const activeSample = users.filter((user) => user?.uuid).slice(0, 10);
const subscriptionsBefore = new Map();
for (const user of activeSample) {
  subscriptionsBefore.set(user.id, await buildUserSubscriptionBody(user));
}

const existingServers = await listServers();
const existingById = new Map(existingServers.map((server) => [server.id, server]));
const timestamp = nowIso();
const serverDocs = definitions.map((definition, index) => {
  const existing = existingById.get(definition.id);
  return {
    ...existing,
    ...definition,
    service: definition.id,
    region: 'external-vps',
    enabled: true,
    newUsersOnly: true,
    externalVps: true,
    standalonePilot: true,
    subscriptionHidden: true,
    addToNewClients: true,
    minInstances: 0,
    maxInstances: 1,
    sortOrder: Number(definition.sortOrder ?? existing?.sortOrder ?? 900 + index),
    updatedAt: timestamp,
    createdAt: existing?.createdAt || timestamp,
  };
});

if (DRY_RUN) {
  console.log(JSON.stringify({ dryRun: true, serverDocs, subscriptionWrites: 0 }, null, 2));
  process.exit(0);
}

for (const server of serverDocs) {
  await upsertServer(server.id, server);
}
const retiredFr2 = existingById.get('pilot-fr2-tcp');
if (retiredFr2) {
  await upsertServer('pilot-fr2-tcp', {
    ...retiredFr2,
    enabled: false,
    addToNewClients: false,
    newUsersOnly: true,
    subscriptionHidden: true,
    updatedAt: timestamp,
  });
}

const panelAfter = await getPanelSettings();
const changedSubscriptions = [];
for (const user of activeSample) {
  const after = await buildUserSubscriptionBody(user);
  if (
    after !== subscriptionsBefore.get(user.id) &&
    !(ALLOW_DAYANCH_CHANGE && user.id === DAYANCH_VIP_USER_ID)
  ) {
    changedSubscriptions.push(user.id);
  }
}

if (changedSubscriptions.length) {
  throw new Error(`Pilot registration changed generated subscriptions: ${changedSubscriptions.join(', ')}`);
}
if (Number(panelAfter.subscriptionMinServers) !== Number(panelBefore.subscriptionMinServers)) {
  throw new Error('subscriptionMinServers changed unexpectedly');
}

console.log(
  JSON.stringify(
    {
      ok: true,
      registered: serverDocs.map((server) => ({
        id: server.id,
        enabled: server.enabled,
        newUsersOnly: server.newUsersOnly,
        subscriptionHidden: server.subscriptionHidden,
      })),
      subscriptionWrites: 0,
      sampledSubscriptionsUnchanged: activeSample.length,
      subscriptionMinServers: panelAfter.subscriptionMinServers,
    },
    null,
    2
  )
);
