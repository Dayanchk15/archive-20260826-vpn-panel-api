import { listUsers } from './db-store.js';
import { upsertUserSubscriptionFile } from './user-subscription-file.js';

const DEFAULT_BATCH_DELAY_MS = 1000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

let refreshInProgress = false;

/**
 * Refresh stored subscription snapshots without touching Xray/edge sessions.
 * Traffic is read from PostgreSQL by listUsers(), then embedded into the
 * generated local subscription file.
 */
export async function refreshAllUserSubscriptionFiles({ reason = 'scheduled' } = {}) {
  if (refreshInProgress) {
    return { ok: true, skipped: true, reason: 'already-running' };
  }

  refreshInProgress = true;
  const startedAt = Date.now();
  const delayMs = positiveInteger(
    process.env.SUBSCRIPTION_REFRESH_BATCH_DELAY_MS,
    DEFAULT_BATCH_DELAY_MS
  );
  const result = {
    ok: true,
    reason,
    total: 0,
    refreshed: 0,
    failed: 0,
    failures: [],
    durationMs: 0,
  };

  try {
    const users = await listUsers();
    result.total = users.length;

    // Sequential updates avoid a burst after a restart. Traffic values are
    // already joined from PostgreSQL.
    for (const user of users) {
      try {
        await upsertUserSubscriptionFile(user);
        result.refreshed += 1;
      } catch (error) {
        result.ok = false;
        result.failed += 1;
        if (result.failures.length < 20) {
          result.failures.push({
            userId: user?.id || null,
            error: error?.message || String(error),
          });
        }
      }
      await sleep(delayMs);
    }
  } catch (error) {
    result.ok = false;
    result.error = error?.message || String(error);
  } finally {
    result.durationMs = Date.now() - startedAt;
    refreshInProgress = false;
  }

  return result;
}

export function getSubscriptionRefreshIntervalMs() {
  return Math.max(
    1000,
    positiveInteger(process.env.SUBSCRIPTION_REFRESH_INTERVAL_MS, 30 * 60 * 1000)
  );
}

export function subscriptionBackgroundRefreshEnabled() {
  return process.env.SUBSCRIPTION_BACKGROUND_REFRESH_ENABLED !== '0';
}
