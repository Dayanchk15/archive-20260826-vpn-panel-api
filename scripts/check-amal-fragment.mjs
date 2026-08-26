#!/usr/bin/env node
import { getPanelSettings } from '../lib/settings.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { resolveHappFragmentationForUser } from '../lib/happ-fragmentation.js';
import { listUsers } from '../lib/db-store.js';

const panel = await getPanelSettings();
const user = (await listUsers()).find((u) => String(u.name || '').includes('Amal'));
const frag = resolveHappFragmentationForUser(panel, user);
const body = user ? await buildUserSubscriptionBody(user) : '';
console.log(JSON.stringify({
  panelHappFragmentationEnabled: panel.happFragmentationEnabled,
  env: process.env.HAPP_FRAGMENTATION_ENABLED,
  resolvedFragmentation: frag,
  bodyHasFragment: body.includes('fragment=') || body.includes('#fragmentation'),
  user: user ? { name: user.name, id: user.id } : null,
}, null, 2));
