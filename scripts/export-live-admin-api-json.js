import 'dotenv/config';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const adminKey = process.env.ADMIN_API_KEY || '';
const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

if (!adminKey || !baseUrl) {
  console.error('ADMIN_API_KEY and PUBLIC_BASE_URL are required in .env');
  process.exit(1);
}

async function getJson(route) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { 'x-admin-key': adminKey },
  });
  if (!response.ok) {
    throw new Error(`${route} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const [usersResponse, serversResponse, filesResponse, panelSettingsResponse, globalSubscriptionResponse] =
  await Promise.all([
    getJson('/admin/users'),
    getJson('/admin/servers'),
    getJson('/admin/files'),
    getJson('/admin/settings/panel'),
    getJson('/admin/subscription/global'),
  ]);

const users = (usersResponse.users || []).map((user) => ({
  id: user.id,
  data: user,
}));

const servers = (serversResponse.servers || []).map((server) => ({
  id: server.id,
  data: server,
}));

const fileDetails = await Promise.all(
  (filesResponse.files || []).map(async (file) => {
    try {
      const detail = await getJson(`/admin/files/${file.id}`);
      return detail.file || file;
    } catch {
      return file;
    }
  })
);

const files = fileDetails.map((file) => ({
  id: file.id,
  data: file,
}));

const backup = {
  exportedAt: new Date().toISOString(),
  source: 'live-admin-api',
  users,
  servers,
  files,
  settings: {
    panel: panelSettingsResponse.settings || panelSettingsResponse,
    globalSubscription: globalSubscriptionResponse.global || globalSubscriptionResponse,
  },
};

await mkdir('backup', { recursive: true });
const out = path.join('backup', `live-admin-api-export-${Date.now()}.json`);
await writeFile(out, JSON.stringify(backup, null, 2));

console.log(JSON.stringify({
  ok: true,
  file: out,
  users: users.length,
  servers: servers.length,
  files: files.length,
}, null, 2));
