import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSafeCleanupPreview } from '../lib/server-maintenance-audit.js';

test('maintenance cleanup remains non-executable for a healthy idle server', () => {
  const preview = buildSafeCleanupPreview({
    ok: true,
    disk: { usedPercent: 40 },
    capabilities: { analyze: true, cleanup: false, restart: false },
  });

  assert.equal(preview.executable, false);
  assert.equal(preview.mode, 'preview-only');
  assert.equal(preview.risk, 'blocked-read-only');
  assert.ok(preview.blockers.includes('cleanup-capability-disabled'));
});

test('active client sessions are always a cleanup blocker', () => {
  const preview = buildSafeCleanupPreview({
    ok: true,
    disk: { usedPercent: 91 },
    capabilities: { cleanup: false },
  }, { activeSessions: 12 });

  assert.equal(preview.executable, false);
  assert.equal(preview.risk, 'blocked-active-clients');
  assert.equal(preview.diskPressure, 'critical');
  assert.ok(preview.blockers.includes('active-sessions'));
});

test('unavailable diagnostics cannot produce an executable plan', () => {
  const preview = buildSafeCleanupPreview({ ok: false });

  assert.equal(preview.executable, false);
  assert.ok(preview.blockers.includes('diagnostics-unavailable'));
  assert.ok(preview.blockers.includes('cleanup-capability-disabled'));
});
