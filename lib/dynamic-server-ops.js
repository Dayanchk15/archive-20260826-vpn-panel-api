import { listUsers } from './db-store.js';
import { upsertUserSubscriptionFile } from './user-subscription-file.js';

export const RETIRED_DEPLOYMENT_FIELDS = new Set();
export const SUBSCRIPTION_REFRESH_FIELDS = new Set(['enabled','host','port','path','security','sni','addressIp','network','fingerprint','alpn','xhttpMode','xhttpExtra','name','flag','country','remark','sortOrder']);
export function enrichServerUpdateFields(update = {}) { return { ...update }; }
export function shouldApplyDeploymentAfterServerUpdate() { return false; }
export function shouldRefreshSubscriptionsAfterServerUpdate(update = {}) { return Object.keys(update).some((field) => SUBSCRIPTION_REFRESH_FIELDS.has(field)); }
let refreshing = false; let queued = false;
async function refreshLoop() { if (refreshing) return; refreshing = true; try { while (queued) { queued = false; for (const user of await listUsers()) { try { await upsertUserSubscriptionFile(user); } catch (error) { console.error(`Subscription refresh failed for ${user.id}:`, error.message); } } } } finally { refreshing = false; } }
export function scheduleSubscriptionRefreshAll() { queued = true; void refreshLoop(); return { background: true, queued: true }; }
export async function applyDynamicServerChangeEffects(_serverId, update = {}) { return { deployment: { ok: true, disabled: true }, subscriptions: shouldRefreshSubscriptionsAfterServerUpdate(update) ? scheduleSubscriptionRefreshAll() : null, edgeSync: null }; }
export function summarizeServerForPanel(server) { return { scaling: null, panelEnabled: server.enabled !== false }; }
