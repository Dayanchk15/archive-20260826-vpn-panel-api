import { buildEdgeClientList } from './edge-clients.js';
import { getSetting, setSetting } from './postgres.js';

// Remote deployment has been retired. Keep the public API used by subscriptions
// and background jobs, but only publish a local VPS registry.
const REGISTRY_KEY = 'vpnEdgeRegistry';

export const DEFAULT_WARM_SERVER_IDS = [];

export async function resolveWarmServerIds(serverIds) {
  return Array.isArray(serverIds) ? serverIds.map(String).filter(Boolean) : [];
}

export async function publishClientRegistry() {
  const clients = await buildEdgeClientList();
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    count: clients.length,
    uuids: clients.map((client) => client.uuid),
    clients,
  };
  await setSetting(REGISTRY_KEY, payload);
  return payload;
}

export async function getClientRegistry() {
  return (await getSetting(REGISTRY_KEY)) || { version: 1, count: 0, uuids: [], clients: [] };
}

export function resolveServerDeploymentScaling(_server) {
  return null;
}

export async function applyServerPanelState(server) {
  return { ok: true, disabled: true, skipped: true, serverId: server?.id || null };
}

export async function reconcileAllServerStates() {
  return { ok: true, disabled: true, updated: [], skipped: [], failed: [] };
}

export async function syncVpnEdgeClients(options = {}) {
  const registry = await publishClientRegistry();
  return {
    ok: true,
    registry,
    registryCount: registry.count,
    uuids: registry.uuids,
    deployment: { enabled: false, attempted: 0, updated: [], skipped: [], failed: [], timedOut: [] },
    disabled: true,
    serverIds: Array.isArray(options.serverIds) ? options.serverIds.map(String) : null,
    message: 'Client registry updated; remote deployment is disabled.',
  };
}

export async function syncVpnEdgeClientsPhased(options = {}) {
  const phase1 = await syncVpnEdgeClients(options);
  return {
    ok: true,
    phase1,
    phase2: null,
    phase2Detail: null,
    background: false,
    partial: false,
    message: phase1.message,
    deployment: phase1.deployment,
    registry: phase1.registry,
    registryCount: phase1.registryCount,
  };
}
