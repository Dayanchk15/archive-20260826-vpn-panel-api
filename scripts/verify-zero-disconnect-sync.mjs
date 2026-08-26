#!/usr/bin/env node
/**
 * Verify zero-disconnect agent sync: push clients to pilot edge(s) and check agent status.
 *
 *   docker exec vpn-panel-api-vps node /app/scripts/verify-zero-disconnect-sync.mjs
 *   PILOT_EDGE=relay-eu-am node scripts/verify-zero-disconnect-sync.mjs
 */
import { syncRelayEdgesViaAgent, getRelayAgentSyncState } from '../lib/relay-edge-agent-sync.js';
import { getRelayEdgeSyncStatusSummary } from '../lib/relay-edge-sync-status.js';
import { agentUrlForEdge, listRelayAgentEdges } from '../lib/relay-edge-registry.js';

const SYNC_KEY = String(process.env.EDGE_SYNC_KEY || process.env.EDGE_REPORT_KEY || '').trim();
const pilotId = String(process.env.PILOT_EDGE || 'relay-eu-am').trim();
const edges = listRelayAgentEdges().filter((e) => e.id === pilotId);
if (!edges.length) {
  console.error(`Pilot edge not found in agent registry: ${pilotId}`);
  process.exit(1);
}

console.log(JSON.stringify({ step: 'agentState', ...getRelayAgentSyncState() }, null, 2));

const push = await syncRelayEdgesViaAgent({ phasedWarm: false });
console.log(JSON.stringify({ step: 'push', push }, null, 2));

const statusChecks = [];
for (const edge of edges) {
  const url = `${agentUrlForEdge(edge)}/v1/status`;
  try {
    const res = await fetch(url, {
      headers: SYNC_KEY ? { 'x-edge-sync-key': SYNC_KEY } : {},
    });
    const body = await res.json().catch(() => ({}));
    statusChecks.push({
      edgeId: edge.id,
      ok: res.ok && body.ok !== false,
      status: res.status,
      clientCount: body.clientCount ?? null,
      lastFingerprint: body.lastFingerprint ?? null,
      lastAppliedAt: body.lastAppliedAt ?? null,
      lastError: body.lastError ?? null,
      applyMode: body.applyMode ?? null,
    });
  } catch (err) {
    statusChecks.push({ edgeId: edge.id, ok: false, error: err.message || String(err) });
  }
}

const summary = await getRelayEdgeSyncStatusSummary();
const failed = statusChecks.filter((c) => !c.ok);
const ok = push.ok && failed.length === 0;

console.log(
  JSON.stringify(
    {
      ok,
      pilotEdge: pilotId,
      pushOk: push.ok,
      pushMessage: push.message,
      statusChecks,
      panelSummary: summary,
    },
    null,
    2
  )
);
process.exit(ok ? 0 : 1);
