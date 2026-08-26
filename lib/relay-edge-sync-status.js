import { getSetting, isPostgresEnabled, setSetting } from './postgres.js';
import { nowIso } from './dates.js';

const SETTINGS_KEY = 'relayEdgeAgentSyncStatus';

export async function readRelayEdgeSyncStatus() {
  if (!isPostgresEnabled()) {
    return { edges: {}, updatedAt: null };
  }
  const data = await getSetting(SETTINGS_KEY);
  return data && typeof data === 'object' ? data : { edges: {}, updatedAt: null };
}

export async function updateRelayEdgeStatus(edgeId, patch) {
  const current = await readRelayEdgeSyncStatus();
  const edges = { ...(current.edges || {}) };
  edges[edgeId] = {
    ...(edges[edgeId] || {}),
    ...patch,
    edgeId,
    updatedAt: nowIso(),
  };
  const next = { edges, updatedAt: nowIso() };
  await setSetting(SETTINGS_KEY, next);
  return next;
}

export async function getRelayEdgeSyncStatusSummary() {
  const status = await readRelayEdgeSyncStatus();
  const edges = Object.values(status.edges || {});
  return {
    ok: true,
    applyMode: 'hot-diff',
    updatedAt: status.updatedAt,
    edges: edges.map((edge) => ({
      edgeId: edge.edgeId,
      isConnected: Boolean(edge.isConnected),
      lastFingerprint: edge.lastFingerprint || null,
      lastAppliedAt: edge.lastAppliedAt || null,
      lastApplied: edge.lastApplied ?? null,
      lastError: edge.lastError || null,
      lastSessionDropCount: Number(edge.lastSessionDropCount ?? 0),
      clientCount: edge.clientCount ?? null,
      activeSessions: edge.activeSessions ?? null,
    })),
  };
}
