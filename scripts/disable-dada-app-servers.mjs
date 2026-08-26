/**
 * Remove every server from DADA VPN and DADA Connect without changing Happ
 * subscriptions or the main enabled state of any server.
 *
 * Dry run:
 *   node scripts/disable-dada-app-servers.mjs
 *
 * Apply:
 *   node scripts/disable-dada-app-servers.mjs --apply
 */

const apply = process.argv.includes('--apply');
const baseUrl = String(process.env.PANEL_INTERNAL_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const adminKey = String(process.env.ADMIN_API_KEY || '');

if (!adminKey) throw new Error('ADMIN_API_KEY is required');

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-admin-key': adminKey,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${payload.error || response.statusText}`);
  }
  return payload;
}

const mobile = await request('/admin/settings/mobile/servers');
const connect = await request('/admin/settings/hiddify-android/servers');
const mobileRuntime = await request('/admin/settings/mobile');
const connectRuntime = await request('/admin/settings/hiddify-android');
const reliability = await request('/admin/system/reliability');
const relayStatus = await request('/admin/relay-edge-sync/status');
const mobileEnabled = (mobile.servers || []).filter((server) => server.mobileEnabled === true);
const connectEnabled = (connect.servers || []).filter((server) => server.hiddifyAndroidEnabled === true);

function syncSummary(state) {
  return {
    inProgress: Boolean(state?.inProgress),
    queued: Boolean(state?.queued),
    lastSuccessAt: state?.lastSuccessAt || null,
    lastError: state?.lastError || null,
    healthy: state?.healthy !== false,
  };
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  dadaVpnEnabled: mobileRuntime.settings?.enabled !== false,
  dadaConnectEnabled: connectRuntime.settings?.enabled !== false,
  activeSessions: {
    dadaVpn: Number(mobileRuntime.status?.activePublicSessions || 0),
    dadaConnect: Number(connectRuntime.status?.activeSessions || 0),
  },
  edgeSync: syncSummary(reliability.backgroundSync),
  relaySync: syncSummary(relayStatus.backgroundSync),
  dadaVpnServersToRemove: mobileEnabled.map(({ id, name }) => ({ id, name })),
  dadaConnectServersToRemove: connectEnabled.map(({ id, name }) => ({ id, name })),
}, null, 2));

if (!apply) process.exit(0);

for (const server of mobileEnabled) {
  await request(`/admin/settings/mobile/servers/${encodeURIComponent(server.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ mobileEnabled: false }),
  });
}

for (const server of connectEnabled) {
  await request(`/admin/settings/hiddify-android/servers/${encodeURIComponent(server.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ hiddifyAndroidEnabled: false }),
  });
}

// Disable both application APIs as well. This revokes their public sessions and
// schedules a full edge sync so the public DADA UUIDs are removed from Xray.
const mobileSettings = await request('/admin/settings/mobile', {
  method: 'PUT',
  body: JSON.stringify({ enabled: false }),
});
const connectSettings = await request('/admin/settings/hiddify-android', {
  method: 'PUT',
  body: JSON.stringify({ enabled: false }),
});

await request('/admin/settings/mobile/servers/refresh', { method: 'POST', body: '{}' });
await request('/admin/settings/hiddify-android/servers/refresh', { method: 'POST', body: '{}' });
const sync = await request('/admin/sync-edge/start', { method: 'POST', body: '{}' });

const mobileAfter = await request('/admin/settings/mobile/servers');
const connectAfter = await request('/admin/settings/hiddify-android/servers');
const remainingMobile = (mobileAfter.servers || []).filter((server) => server.mobileEnabled === true);
const remainingConnect = (connectAfter.servers || []).filter((server) => server.hiddifyAndroidEnabled === true);

if (remainingMobile.length || remainingConnect.length) {
  throw new Error(
    `Verification failed: DADA VPN=${remainingMobile.length}, DADA Connect=${remainingConnect.length}`
  );
}

console.log(JSON.stringify({
  ok: true,
  dadaVpnServers: 0,
  dadaConnectServers: 0,
  dadaVpnEnabled: mobileSettings.settings?.enabled ?? mobileSettings.enabled ?? false,
  dadaConnectEnabled: connectSettings.settings?.enabled ?? connectSettings.enabled ?? false,
  revokedSessions: {
    dadaVpn: Number(mobileSettings.revokedSessions || 0),
    dadaConnect: Number(connectSettings.revokedSessions || 0),
  },
  edgeSync: sync,
}, null, 2));
