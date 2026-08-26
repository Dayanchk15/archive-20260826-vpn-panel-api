import { listUsers, listServers } from './db-store.js';
import { getBackgroundSyncState } from './background-sync.js';
import { telegramAlertsEnabled } from './telegram-alert.js';

function parseExpiresMs(expiresAt) {
  if (!expiresAt) return null;
  const d = new Date(expiresAt);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export async function getSystemHealthSummary(options = {}) {
  const includeCost = options.includeCost !== false;
  const [users, servers, sync] = await Promise.all([
    listUsers(),
    listServers(),
    Promise.resolve(getBackgroundSyncState()),
  ]);

  const now = Date.now();
  const enabled = servers.filter((s) => s.enabled !== false);
  const warm = enabled.filter((s) => Number(s.minInstances ?? 0) >= 1);
  const cold = enabled.length - warm.length;

  const scalingDrift = 0;

  const active = users.filter((u) => u.status === 'active').length;
  const expired = users.filter((u) => {
    const ms = parseExpiresMs(u.expiresAt);
    return u.status === 'active' && ms != null && ms < now;
  }).length;
  const disabledExpired = users.filter((u) => {
    const ms = parseExpiresMs(u.expiresAt);
    return u.status !== 'active' && ms != null && ms < now;
  }).length;
  const expiringSoon = users.filter((u) => {
    const ms = parseExpiresMs(u.expiresAt);
    if (ms == null || u.status !== 'active') return false;
    const diff = ms - now;
    return diff > 0 && diff < 7 * 86400000;
  }).length;

  const cost = null;

  return {
    checkedAt: new Date().toISOString(),
    users: {
      total: users.length,
      active,
      expired,
      disabledExpired,
      expiringSoon,
    },
    nodes: {
      enabled: enabled.length,
      warm: warm.length,
      cold,
      warmNames: warm.map((s) => s.service || s.name).filter(Boolean),
    },
    sync: {
      inProgress: Boolean(sync?.inProgress),
      queued: Boolean(sync?.queued),
      lastSuccessAt: sync?.lastSuccessAt || null,
      lastError: sync?.lastError || null,
    },
    alerts: {
      telegram: telegramAlertsEnabled(),
    },
    scalingDrift,
    cost,
    ok:
      !sync?.lastError &&
      expired === 0 &&
      scalingDrift === 0,
  };
}
