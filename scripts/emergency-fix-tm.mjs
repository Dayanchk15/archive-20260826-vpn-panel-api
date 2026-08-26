#!/usr/bin/env node
/**
 * Emergency fix: panel TM settings + all nodes warm + full sync + subscription test.
 */
import { listServers, listUsers, updateServer } from '../lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildUserSubscriptionUrls } from '../lib/user-urls.js';
import { nowIso } from '../lib/dates.js';

const panel = await getPanelSettings();
const panelUpdate = {
  importUrlMode: 'api',
  subscriptionBaseUrl: 'https://sub.twidu.com',
  connectionMode: 'masked',
  preferGcsDirectUrl: false,
  infoRowHost: process.env.INFO_ROW_HOST || 'www.google.com',
  infoRowPort: Number(panel.infoRowPort || 80),
  updatedAt: nowIso(),
};
await updatePanelSettings({ ...panel, ...panelUpdate });

const servers = (await listServers()).filter((s) => s.enabled !== false);
const serverResults = [];
for (const server of servers) {
  await updateServer(server.id, { minInstances: 1, updatedAt: nowIso() });
  const fresh = { ...server, minInstances: 1 };
  const edge = await applyCloudRunServerPanelState(fresh);
  serverResults.push({
    service: server.service,
    ok: edge.ok,
    minInstances: edge.scaling?.minInstances,
    clients: edge.clientCount,
  });
}

let refreshed = 0;
const sampleUrls = [];
for (const user of await listUsers()) {
  const file = await upsertUserSubscriptionFile(user);
  refreshed += 1;
  if (sampleUrls.length < 3 && user.token) {
    const urls = await buildUserSubscriptionUrls({
      userId: user.id,
      token: user.token,
      subscriptionFile: file,
      panelSettings: { ...panel, ...panelUpdate },
    });
    sampleUrls.push({ name: user.name, url: urls.subscriptionUrl, mode: urls.importUrlMode });
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      panel: panelUpdate,
      servers: serverResults.length,
      serverFailures: serverResults.filter((s) => !s.ok),
      subscriptionsRefreshed: refreshed,
      sampleUrls,
    },
    null,
    2
  )
);
