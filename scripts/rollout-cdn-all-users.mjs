#!/usr/bin/env node
import { listServers, listUsers, updateUser, upsertServer } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { nowIso } from '/app/lib/dates.js';

const now = nowIso();
const definitions = [
  {
    id: 'cf-tampa', name: 'Tampa Cloudflare', country: 'USA 2', flag: '🇺🇸',
    host: 'tampa.levospeed.click', addressIp: '104.16.0.1', service: 'cf-tampa',
    network: 'grpc', path: 'tampa-sync', grpcServiceName: 'tampa-sync',
    grpcAuthority: 'tampa.levospeed.click', sni: 'tampa.levospeed.click', alpn: 'h2',
  },
  {
    id: 'cf-fornex', name: 'Fornex Cloudflare', country: 'Germany 2', flag: '🇩🇪',
    host: 'fornex.levospeed.click', addressIp: '104.16.0.1', service: 'cf-fornex',
    network: 'grpc', path: 'fornex-sync', grpcServiceName: 'fornex-sync',
    grpcAuthority: 'fornex.levospeed.click', sni: 'fornex.levospeed.click', alpn: 'h2',
  },
  {
    id: 'cf-fr2', name: 'FR2 Cloudflare', country: 'France 2', flag: '🇫🇷',
    host: 'fr2.levospeed.click', addressIp: '104.16.0.1', service: 'cf-fr2',
    network: 'grpc', path: 'fr2-sync', grpcServiceName: 'fr2-sync',
    grpcAuthority: 'fr2.levospeed.click', sni: 'fr2.levospeed.click', alpn: 'h2',
  },
  {
    id: 'bunny-tampa', name: 'Tampa Bunny', country: 'USA 3', flag: '🇺🇸',
    host: 'levospeedtampa.b-cdn.net', addressIp: '138.199.36.9', service: 'bunny-tampa',
    network: 'ws', path: '/bunny/tampa', sni: 'levospeedtampa.b-cdn.net', alpn: 'http/1.1',
  },
  {
    id: 'bunny-fornex', name: 'Fornex Bunny', country: 'Germany 3', flag: '🇩🇪',
    host: 'levospeedfornex.b-cdn.net', addressIp: '138.199.36.9', service: 'bunny-fornex',
    network: 'ws', path: '/assets/v3/sync', sni: 'levospeedfornex.b-cdn.net', alpn: 'http/1.1',
  },
  {
    id: 'bunny-fr2', name: 'FR2 Bunny', country: 'France 3', flag: '🇫🇷',
    host: 'levospeedfr2.b-cdn.net', addressIp: '138.199.36.9', service: 'bunny-fr2',
    network: 'ws', path: '/bunny/fr2', sni: 'levospeedfr2.b-cdn.net', alpn: 'http/1.1',
  },
];

const existing = await listServers();
const existingById = new Map(existing.map((server) => [String(server.id), server]));
let sortOrder = Math.max(0, ...existing.map((server) => Number(server.sortOrder || 0))) + 1;

for (const definition of definitions) {
  const previous = existingById.get(definition.id);
  await upsertServer(definition.id, {
    ...definition,
    port: 443,
    protocol: 'vless',
    security: 'tls',
    fingerprint: 'chrome',
    enabled: true,
    minInstances: 1,
    maxInstances: 1,
    externalVps: true,
    subscriptionEligible: true,
    addToNewClients: true,
    newUsersOnly: false,
    subscriptionHidden: false,
    rejectUdp443: true,
    sortOrder: previous?.sortOrder ?? sortOrder++,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  });
}

const serverIds = definitions.map((server) => server.id);
let updated = 0;
let refreshed = 0;
for (const user of await listUsers(5000)) {
  const previous = Array.isArray(user.bonusServerIds) ? user.bonusServerIds.map(String) : [];
  const previousPinned = Array.isArray(user.pinnedServerIds) ? user.pinnedServerIds.map(String) : [];
  const bonusServerIds = [...serverIds, ...previous.filter((id) => !serverIds.includes(id))];
  const pinnedServerIds = [...serverIds, ...previousPinned.filter((id) => !serverIds.includes(id))];
  const bonusChanged = bonusServerIds.join('\n') !== previous.join('\n');
  const pinnedChanged = pinnedServerIds.join('\n') !== previousPinned.join('\n');
  if (bonusChanged || pinnedChanged) {
    await updateUser(user.id, { bonusServerIds, pinnedServerIds, updatedAt: nowIso() });
    updated += 1;
  }
  await upsertUserSubscriptionFile({ ...user, bonusServerIds, pinnedServerIds });
  refreshed += 1;
}

console.log(JSON.stringify({ ok: true, servers: serverIds, usersUpdated: updated, subscriptionsRefreshed: refreshed }, null, 2));
