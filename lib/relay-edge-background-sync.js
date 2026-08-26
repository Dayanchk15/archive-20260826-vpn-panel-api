import { syncRelayVpsEdges } from './relay-edge-sync.js';

const DEBOUNCE_MS = Math.max(0, Number(process.env.RELAY_EDGE_SYNC_DEBOUNCE_MS || 45000));

let syncInProgress = false;
let syncQueued = false;
let debounceTimer = null;
let lastResult = null;
let lastError = null;
let lastSuccessAt = null;

async function runSyncLoop() {
  if (syncInProgress) return;
  syncInProgress = true;

  try {
    while (syncQueued) {
      syncQueued = false;
      lastResult = await syncRelayVpsEdges();
      if (!lastResult?.ok && !lastResult?.skipped) {
        lastError = new Error(lastResult?.message || 'Relay edge sync failed');
      } else {
        lastError = null;
        if (lastResult?.ok) lastSuccessAt = new Date().toISOString();
      }
    }
  } catch (err) {
    lastError = err;
    console.error('Background relay edge sync error:', err.message || err);
  } finally {
    syncInProgress = false;
    if (syncQueued) {
      runSyncLoop().catch((err) => console.error('Relay edge sync loop restart error:', err));
    }
  }
}

function startSyncNow() {
  syncQueued = true;
  if (!syncInProgress) {
    runSyncLoop().catch((err) => console.error('Relay edge sync start error:', err));
  }
}

export function scheduleRelayEdgeSync(options = {}) {
  const immediate = options.immediate === true || DEBOUNCE_MS === 0;

  if (immediate) {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    startSyncNow();
    return {
      background: true,
      immediate: true,
      queued: true,
      inProgress: syncInProgress,
      message: 'Relay edge sync started in background',
    };
  }

  if (!debounceTimer) {
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      startSyncNow();
    }, DEBOUNCE_MS);
  }

  return {
    background: true,
    debounced: true,
    debounceMs: DEBOUNCE_MS,
    queued: true,
    inProgress: syncInProgress,
    message: `Relay edge sync scheduled in ${Math.round(DEBOUNCE_MS / 1000)}s`,
  };
}

export function getRelayEdgeBackgroundSyncState() {
  return {
    inProgress: syncInProgress,
    queued: syncQueued || Boolean(debounceTimer),
    debounceMs: DEBOUNCE_MS,
    lastSuccessAt,
    lastResult,
    lastError: lastError ? lastError.message || String(lastError) : null,
    healthy: !lastError,
  };
}
