#!/usr/bin/env node
/**
 * Rollout r0 panel changes for zero-disconnect relay sync.
 * Skips Cloud Run relay redeploy — panel + agent sync only.
 *
 *   docker exec vpn-panel-api-vps node /app/scripts/rollout-r0-panel.mjs
 *   DRY_RUN=1 node scripts/rollout-r0-panel.mjs
 */
import { getPanelSettings } from '../lib/settings.js';
import { getRelayAgentSyncState } from '../lib/relay-edge-agent-sync.js';
import { getRelayEdgeBackgroundSyncState } from '../lib/relay-edge-background-sync.js';
import { getRelayEdgeSyncStatusSummary } from '../lib/relay-edge-sync-status.js';
import { resolveRelayEdgeSyncMode } from '../lib/relay-edge-registry.js';
import { scheduleRelayEdgeSync } from '../lib/relay-edge-background-sync.js';

const DRY_RUN = process.env.DRY_RUN === '1';

const panel = await getPanelSettings();
const syncMode = resolveRelayEdgeSyncMode();
const agentState = getRelayAgentSyncState();
const background = getRelayEdgeBackgroundSyncState();
const edgeStatus = await getRelayEdgeSyncStatusSummary();

const plan = {
  step: 'rollout-r0-panel',
  dryRun: DRY_RUN,
  subscriptionRelayOnly: panel.subscriptionRelayOnly === true,
  syncMode,
  skipCloudRunRelay: true,
  actions: [
    'Panel code deploy (docker pull/restart vpn-panel-api-vps)',
    'RELAY_EDGE_SYNC_MODE=agent (default)',
    'EDGE_SYNC_KEY must match edge agents',
    'Pilot install-edge-sync-agent.mjs on relay-eu-am',
    'verify-zero-disconnect-sync.mjs',
    'bootstrap-edge-handler.mjs per edge if HandlerService missing',
  ],
  current: {
    agentState,
    background,
    edgeStatus,
  },
};

console.log(JSON.stringify(plan, null, 2));

if (!panel.subscriptionRelayOnly) {
  console.warn('WARN: subscriptionRelayOnly is false — relay-only sync may be skipped');
}

if (!agentState.syncKeyConfigured) {
  console.error('BLOCK: EDGE_SYNC_KEY not configured on panel');
  process.exit(1);
}

if (!DRY_RUN) {
  const scheduled = scheduleRelayEdgeSync({ immediate: true });
  console.log(JSON.stringify({ step: 'scheduleRelayEdgeSync', scheduled }, null, 2));
}

console.log(
  JSON.stringify(
    {
      ok: true,
      message:
        'r0 panel rollout runner complete (no Cloud Run relay deploy). Deploy panel container on VPS, then run install-edge-sync-agent on pilot AM.',
      nextManualSteps: [
        'scp/rsync panel code to VPS and restart vpn-panel-api-vps',
        'node scripts/install-edge-sync-agent.mjs (pilot relay-eu-am)',
        'node scripts/verify-zero-disconnect-sync.mjs',
      ],
    },
    null,
    2
  )
);
