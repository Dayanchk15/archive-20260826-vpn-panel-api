import { buildEdgeClientList } from './edge-clients.js';
import { clientsFingerprint, shouldSyncRelayEdges } from './relay-edge-sync.js';
import {
  agentUrlForEdge,
  listRelayAgentEdges,
  resolveRelayEdgeSyncMode,
} from './relay-edge-registry.js';
import { updateRelayEdgeStatus } from './relay-edge-sync-status.js';
import { nowIso } from './dates.js';

const SYNC_KEY = String(process.env.EDGE_SYNC_KEY || process.env.EDGE_REPORT_KEY || '').trim();
const PUSH_TIMEOUT_MS = Math.max(3000, Number(process.env.RELAY_EDGE_AGENT_PUSH_TIMEOUT_MS || 12000));
// Panel -> edge :19222 is often blocked by firewall.
// Default to pull-only to avoid timeouts and keep zero-disconnect guarantees.
const PUSH_ENABLED = String(process.env.RELAY_EDGE_AGENT_PUSH_ENABLED || 'false').toLowerCase() === 'true';
const WARM_FIRST_IDS = String(process.env.RELAY_EDGE_AGENT_WARM_FIRST || 'relay-eu-nl,relay-eu-de,relay-eu-am')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PHASE_PAUSE_MS = Math.max(0, Number(process.env.RELAY_EDGE_AGENT_PHASE_PAUSE_MS || 0));

function orderEdges(edges) {
  const warm = [];
  const rest = [];
  const warmSet = new Set(WARM_FIRST_IDS);
  for (const edge of edges) {
    if (warmSet.has(edge.id)) warm.push(edge);
    else rest.push(edge);
  }
  warm.sort((a, b) => WARM_FIRST_IDS.indexOf(a.id) - WARM_FIRST_IDS.indexOf(b.id));
  return [...warm, ...rest];
}

async function pushToEdge(edge, payload) {
  const url = `${agentUrlForEdge(edge)}/v1/clients`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-edge-sync-key': SYNC_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    return {
      id: edge.id,
      ok: res.ok && body.ok !== false,
      status: res.status,
      applied: body.applied ?? null,
      skipped: body.skipped ?? false,
      clientCount: body.clientCount ?? payload.clientCount,
      fingerprint: body.fingerprint || payload.fingerprint,
      error: res.ok ? body.error || null : body.error || `HTTP ${res.status}`,
      lastSessionDropCount: 0,
    };
  } catch (err) {
    return {
      id: edge.id,
      ok: false,
      error: err.name === 'AbortError' ? `push timeout ${PUSH_TIMEOUT_MS}ms` : err.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function pushEdgesParallel(edges, payload) {
  return Promise.all(edges.map((edge) => pushToEdge(edge, payload)));
}

export async function syncRelayEdgesViaAgent(options = {}) {
  const result = {
    ok: false,
    mode: 'agent',
    applyMode: 'hot-diff',
    skipped: false,
    clientCount: 0,
    fingerprint: null,
    edges: [],
    message: '',
  };

  const syncMode = resolveRelayEdgeSyncMode();
  if (syncMode !== 'agent' && syncMode !== 'pilot') {
    result.skipped = true;
    result.ok = true;
    result.message = 'Agent sync skipped (not agent/pilot mode)';
    return result;
  }

  if (!(await shouldSyncRelayEdges())) {
    result.skipped = true;
    result.ok = true;
    result.message = 'Agent sync skipped (not relay-only mode)';
    return result;
  }

  if (!SYNC_KEY) {
    result.message = 'EDGE_SYNC_KEY missing';
    return result;
  }

  const clients = Array.isArray(options.clients) ? options.clients : await buildEdgeClientList();
  const fingerprint = clientsFingerprint(clients);
  result.clientCount = clients.length;
  result.fingerprint = fingerprint;

  const allEdges = listRelayAgentEdges();
  if (!PUSH_ENABLED) {
    // No panel->edge push. Agents will pull /internal/edge/clients every 15s.
    result.skipped = true;
    result.ok = true;
    result.message = `Agent push skipped (pull-only): ${allEdges.length} edges`;
    result.edges = allEdges.map((edge) => ({
      id: edge.id,
      ok: true,
      skipped: true,
      clientCount: clients.length,
      fingerprint,
      lastSessionDropCount: 0,
      error: null,
    }));
    for (const edgeResult of result.edges) {
      await updateRelayEdgeStatus(edgeResult.id, {
        isConnected: false,
        lastFingerprint: edgeResult.fingerprint || fingerprint,
        lastAppliedAt: null,
        lastApplied: null,
        lastError: null,
        lastSessionDropCount: 0,
        clientCount: edgeResult.clientCount ?? clients.length,
      });
    }
    return result;
  }

  const payload = {
    fingerprint,
    clientCount: clients.length,
    clients,
    updatedAt: nowIso(),
  };
  // Panel->edge push (optional, if firewall allows :19222)
  const warmSet = new Set(WARM_FIRST_IDS);
  const warmEdges = orderEdges(allEdges).filter((e) => warmSet.has(e.id));
  const otherEdges = allEdges.filter((e) => !warmSet.has(e.id));

  if (options.phasedWarm !== false && warmEdges.length) {
    result.edges.push(...(await pushEdgesParallel(warmEdges, payload)));
    if (PHASE_PAUSE_MS > 0 && otherEdges.length) {
      await new Promise((r) => setTimeout(r, PHASE_PAUSE_MS));
    }
  }
  if (otherEdges.length) {
    result.edges.push(...(await pushEdgesParallel(otherEdges, payload)));
  }

  for (const edgeResult of result.edges) {
    await updateRelayEdgeStatus(edgeResult.id, {
      isConnected: edgeResult.ok,
      lastFingerprint: edgeResult.fingerprint || fingerprint,
      lastAppliedAt: edgeResult.ok ? nowIso() : null,
      lastApplied: edgeResult.applied,
      lastError: edgeResult.error || null,
      lastSessionDropCount: 0,
      clientCount: edgeResult.clientCount ?? clients.length,
    });
  }

  const failed = result.edges.filter((e) => !e.ok);
  result.ok = failed.length === 0;
  result.message = result.ok
    ? `Agent sync ok (${clients.length} clients, ${result.edges.length} edges)`
    : `Agent sync partial: ${failed.length} failed`;

  if (!result.ok) {
    console.error('Relay agent sync partial failure:', JSON.stringify(result));
  } else {
    console.log('Relay agent sync ok:', JSON.stringify({ clientCount: clients.length, edges: result.edges.length }));
  }

  return result;
}

export function getRelayAgentSyncState() {
  return {
    mode: resolveRelayEdgeSyncMode(),
    syncKeyConfigured: Boolean(SYNC_KEY),
    warmFirstIds: WARM_FIRST_IDS,
    pushTimeoutMs: PUSH_TIMEOUT_MS,
    edges: listRelayAgentEdges().map((edge) => ({
      id: edge.id,
      ip: edge.ip,
      agentUrl: agentUrlForEdge(edge),
    })),
  };
}
