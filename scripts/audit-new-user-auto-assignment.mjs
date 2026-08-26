#!/usr/bin/env node
/** Read-only audit of the server set assigned by the normal create-user route. */
import { listServers } from '/app/lib/db-store.js';
import { applyRelayUserDefaults } from '/app/lib/relay-subscription.js';
import { getPanelSettings } from '/app/lib/settings.js';

const [servers, panel] = await Promise.all([listServers(), getPanelSettings()]);
const projected = await applyRelayUserDefaults({
  id: '__projection__',
  name: '__projection__',
  serverIds: [],
  bonusServerIds: [],
  status: 'active',
}, panel);
const selected = new Set([...(projected.serverIds || []), ...(projected.bonusServerIds || [])].map(String));
const assigned = servers.filter((server) => selected.has(String(server.id)));
const bunny = assigned.filter((server) => String(server.host || '').endsWith('.b-cdn.net')).length;
const cloudflare = assigned.filter((server) => String(server.host || '').endsWith('.levospeed.click')).length;
console.log(JSON.stringify({
  ok: true,
  relayOnly: projected.relayOnly === true,
  assigned: assigned.length,
  relay: assigned.length - bunny - cloudflare,
  bunny,
  cloudflare,
}));
