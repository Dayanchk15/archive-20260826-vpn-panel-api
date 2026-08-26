import { agentUrlForEdge, listRelayAgentEdges } from './relay-edge-registry.js';
import { getRelayEdgeSyncStatusSummary } from './relay-edge-sync-status.js';
import { listMaintenanceReports } from './maintenance-report-store.js';

const AUDIT_KEY = String(process.env.EDGE_SYNC_KEY || process.env.EDGE_REPORT_KEY || '').trim();
const DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.MAINTENANCE_AUDIT_TIMEOUT_MS || 5000));

export function buildSafeCleanupPreview(snapshot = {}, syncStatus = {}) {
  const diskPercent = Number(snapshot.disk?.usedPercent);
  const activeSessions = Number(syncStatus.activeSessions || 0);
  const blockers = [];
  if (!snapshot.ok) blockers.push('diagnostics-unavailable');
  if (activeSessions > 0) blockers.push('active-sessions');
  if (snapshot.capabilities?.cleanup !== true) blockers.push('cleanup-capability-disabled');
  return {
    executable: false,
    mode: 'preview-only',
    risk: activeSessions > 0 ? 'blocked-active-clients' : 'blocked-read-only',
    diskPressure: Number.isFinite(diskPercent) && diskPercent >= 85 ? 'critical'
      : Number.isFinite(diskPercent) && diskPercent >= 75 ? 'warning'
        : 'normal',
    activeSessions,
    blockers,
    proposedActions: [
      'inspect-rotated-logs',
      'inspect-temporary-files',
      'inspect-dangling-container-artifacts',
    ],
  };
}

async function fetchEdgeSnapshot(edge, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${agentUrlForEdge(edge)}/v1/maintenance`, {
      method: 'GET',
      headers: { 'x-edge-sync-key': AUDIT_KEY },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    return { ...body, id: edge.id, reachable: true };
  } catch (err) {
    return {
      ok: false,
      readOnly: true,
      id: edge.id,
      reachable: false,
      error: err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function auditRelayServerMaintenance(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const edges = listRelayAgentEdges();
  const [statusSummary, storedReports] = await Promise.all([
    getRelayEdgeSyncStatusSummary().catch(() => ({ edges: [] })),
    listMaintenanceReports().catch(() => []),
  ]);
  const statusById = new Map((statusSummary.edges || []).map((item) => [item.edgeId, item]));
  const reportById = new Map(storedReports.map((item) => [item.edgeId, item]));

  if (!AUDIT_KEY) {
    return {
      ok: false,
      readOnly: true,
      checkedAt: new Date().toISOString(),
      error: 'EDGE_SYNC_KEY is not configured',
      servers: edges.map((edge) => ({
        id: edge.id,
        ok: false,
        reachable: false,
        error: 'audit-key-missing',
        cleanupPreview: buildSafeCleanupPreview({ ok: false }, statusById.get(edge.id)),
      })),
    };
  }

  const directAudit = String(process.env.MAINTENANCE_DIRECT_AGENT_AUDIT || 'false').toLowerCase() === 'true';
  const snapshots = directAudit
    ? await Promise.all(edges.map((edge) => fetchEdgeSnapshot(edge, timeoutMs)))
    : edges.map((edge) => {
        const report = reportById.get(edge.id);
        const ageMs = report?.receivedAt ? Date.now() - new Date(report.receivedAt).getTime() : Infinity;
        if (!report || !Number.isFinite(ageMs) || ageMs > 15 * 60 * 1000) {
          return { ok: false, readOnly: true, id: edge.id, reachable: false, error: report ? 'stale-report' : 'no-report' };
        }
        return { ...report, id: edge.id, ok: true, reachable: true, reportAgeMs: ageMs };
      });
  const servers = snapshots.map((snapshot) => ({
    ...snapshot,
    sync: statusById.get(snapshot.id) || null,
    cleanupPreview: buildSafeCleanupPreview(snapshot, statusById.get(snapshot.id)),
  }));
  return {
    ok: servers.every((server) => server.ok),
    readOnly: true,
    checkedAt: new Date().toISOString(),
    summary: {
      total: servers.length,
      reachable: servers.filter((server) => server.reachable).length,
      warning: servers.filter((server) => server.cleanupPreview.diskPressure === 'warning').length,
      critical: servers.filter((server) => server.cleanupPreview.diskPressure === 'critical').length,
      cleanupExecutable: 0,
    },
    protections: {
      cleanupExecutable: false,
      restartAllowed: false,
      clientDisconnectAllowed: false,
    },
    servers,
  };
}
