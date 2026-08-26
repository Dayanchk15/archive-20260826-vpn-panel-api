#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { getPanelSettings } from '../lib/settings.js';

const panel = await getPanelSettings();
const users = await listUsers();
const sample = users.find((u) => u.status === 'active') || users[0];
if (!sample) {
  console.log(JSON.stringify({ error: 'no users' }));
  process.exit(1);
}

const file = await getFileByLinkedUserId(sample.id);
const subUrl = file?.slug
  ? `https://sub.twidu.com/f/${file.slug}`
  : `https://sub.twidu.com/api/sub/TEST_NEEDS_TOKEN`;

const started = Date.now();
const res = await fetch(subUrl, { signal: AbortSignal.timeout(30000) });
const ms = Date.now() - started;
const text = await res.text();
console.log(
  JSON.stringify(
    {
      panel: {
        importUrlMode: panel.importUrlMode,
        subscriptionBaseUrl: panel.subscriptionBaseUrl,
        connectionMode: panel.connectionMode,
      },
      user: sample.name,
      subscriptionUrl: subUrl,
      httpStatus: res.status,
      ms,
      bodyLen: text.length,
      hasVless: text.includes('vless://'),
    },
    null,
    2
  )
);
