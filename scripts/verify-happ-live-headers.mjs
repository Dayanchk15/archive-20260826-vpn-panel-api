#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { getPanelSettings } from '../lib/settings.js';

const user = (await listUsers()).find((u) => u.name === 'Makss') || (await listUsers())[0];
const file = await getFileByLinkedUserId(user.id);
const panel = await getPanelSettings();
const base = String(panel.subscriptionBaseUrl || 'https://sub.twidu.com').replace(/\/+$/, '');
const url = `${base}/f/${file.slug}`;

const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
const text = await res.text();
const decoded = text.match(/^[A-Za-z0-9+/=\s]+$/) ? Buffer.from(text.trim(), 'base64').toString('utf8') : text;
const vless = decoded.split('\n').find((l) => l.startsWith('vless://') && l.includes('serverDescription'));

console.log(
  JSON.stringify(
    {
      user: user.name,
      url,
      httpStatus: res.status,
      headers: {
        providerid: res.headers.get('providerid'),
        'hide-settings': res.headers.get('hide-settings'),
      },
      bodyHasProviderId: decoded.includes('#providerid'),
      bodyHasHideSettings: decoded.includes('#hide-settings'),
      bodyHasServerDescription: decoded.includes('serverDescription='),
      vlessFragment: vless ? vless.split('#')[1] : null,
      happProviderId: panel.happProviderId,
    },
    null,
    2
  )
);
