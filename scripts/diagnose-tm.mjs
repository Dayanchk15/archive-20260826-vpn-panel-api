#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { getPanelSettings } from '../lib/settings.js';

const user = (await listUsers()).find((u) => u.status === 'active');
if (!user) {
  console.log(JSON.stringify({ ok: false, error: 'no active user' }));
  process.exit(1);
}

const body = await buildUserSubscriptionBody(user);
const lines = String(body || '').split('\n').filter((l) => l.startsWith('vless://'));
const file = await getFileByLinkedUserId(user.id);
const panel = await getPanelSettings();
const g8 = lines.find((l) => l.includes('germany8') || l.includes('Germany 8'));

console.log(
  JSON.stringify(
    {
      ok: true,
      user: user.name,
      uuid: user.uuid,
      connectionMode: panel.connectionMode,
      importUrlMode: panel.importUrlMode,
      subscriptionBaseUrl: panel.subscriptionBaseUrl,
      addressIps: panel.addressIps,
      vlessLines: lines.length,
      fileHasContent: Boolean(file?.content?.length),
      fileContentLines: file?.content ? file.content.split('\n').filter((l) => l.startsWith('vless')).length : 0,
      germany8Line: g8 ? g8.substring(0, 200) : null,
      allUseTmIp: lines.every((l) => l.includes('216.58.198.46')),
      remarks: lines.map((l) => decodeURIComponent(l.split('#').pop() || '')),
    },
    null,
    2
  )
);
