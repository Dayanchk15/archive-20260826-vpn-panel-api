import { syncVpnEdgeClients } from './vpn-edge-sync.js';

const DEBOUNCE_MS = Math.max(0, Number(process.env.VPN_EDGE_SYNC_DEBOUNCE_MS || 5 * 60 * 1000));

let syncInProgress = false;
let syncQueued = false;
let pendingServerIds = null;
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
      const serverIds = pendingServerIds ? [...pendingServerIds] : undefined;
      pendingServerIds = null;
      lastResult = await syncVpnEdgeClients(serverIds ? { serverIds } : {});
      if (!lastResult?.ok) {
        lastError = new Error(lastResult?.message || 'VPN edge sync failed');
      } else {
        lastError = null;
      }
      lastSuccessAt = new Date().toISOString();
    }
  } catch (err) {
    lastError = err;
    console.error('Background VPN edge sync error:', err.message || err);
    try {
      const { alertBackgroundSyncError } = await import('./telegram-alert.js');
      await alertBackgroundSyncError(err);
    } catch (alertErr) {
      console.error('Telegram background sync alert error:', alertErr.message || alertErr);
    }
  } finally {
    syncInProgress = false;
    if (syncQueued) {
      runSyncLoop().catch((err) => console.error('Background sync loop restart error:', err));
    }
  }
}

function startSyncNow() {
  syncQueued = true;
  if (!syncInProgress) {
    runSyncLoop().catch((err) => console.error('Background sync start error:', err));
  }
}

export function scheduleVpnEdgeSync(options = {}) {
  const immediate = options.immediate === true || DEBOUNCE_MS === 0;

  if (Array.isArray(options.serverIds) && options.serverIds.length) {
    if (!pendingServerIds) pendingServerIds = new Set();
    for (const id of options.serverIds) {
      if (id) pendingServerIds.add(String(id));
    }
  } else if (options.fullSync === true) {
    pendingServerIds = null;
  }

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
      message: 'UUID sync started in background',
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
    message: `UUID sync scheduled in ${Math.round(DEBOUNCE_MS / 1000)}s`,
  };
}

export function getBackgroundSyncState() {
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
