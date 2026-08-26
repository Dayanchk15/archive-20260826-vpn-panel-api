#!/usr/bin/env node
/**
 * Disable orphan panel entries only — no Cloud Run changes, no subscription refresh.
 * Safe for active sessions: orphans are not in user bonusServerIds.
 */
import { getServerById, upsertServer } from '/app/lib/db-store.js';
import { nowIso } from '/app/lib/dates.js';

const ORPHANS = ['gcp2-eu-lv', 'gcp2-eu-de3', 'gcp2-eu-pl'];

const results = [];
for (const id of ORPHANS) {
  const panel = await getServerById(id);
  if (!panel) {
    results.push({ id, action: 'skip', reason: 'not_in_panel' });
    continue;
  }
  if (panel.enabled === false) {
    results.push({ id, action: 'skip', reason: 'already_disabled' });
    continue;
  }
  await upsertServer(id, {
    ...panel,
    enabled: false,
    minInstances: 0,
    updatedAt: nowIso(),
    disabledReason: 'orphan-cleanup-2026-07-09',
  });
  results.push({ id, action: 'disabled', host: panel.host });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      note: 'No subscription refresh — active sessions unchanged',
      results,
    },
    null,
    2
  )
);
