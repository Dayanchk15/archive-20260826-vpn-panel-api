import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listMaintenanceQuarantines,
  maintenanceQuarantineInternals,
  quarantineMaintenanceCandidates,
  restoreMaintenanceQuarantine,
} from '../lib/maintenance-quarantine.js';

test('audited temporary file can be quarantined and restored without deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vpn-maintenance-'));
  try {
    const source = join(root, 'tmp-safe.txt');
    await writeFile(source, 'keep me', 'utf8');
    const job = await quarantineMaintenanceCandidates(['tmp-safe.txt'], { root, confirmPhrase: 'QUARANTINE' });
    assert.equal(job.protections.permanentlyDeleted, false);
    assert.equal((await listMaintenanceQuarantines({ root })).length, 1);
    await assert.rejects(readFile(source, 'utf8'), { code: 'ENOENT' });

    const restored = await restoreMaintenanceQuarantine(job.id, { root, confirmPhrase: 'RESTORE' });
    assert.equal(restored.status, 'restored');
    assert.equal(await readFile(source, 'utf8'), 'keep me');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('quarantine rejects traversal, non-candidates, and missing confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vpn-maintenance-'));
  try {
    await writeFile(join(root, 'normal.txt'), 'important', 'utf8');
    assert.throws(() => maintenanceQuarantineInternals.safeRelativePath('../secret'), /Unsafe/);
    await assert.rejects(
      quarantineMaintenanceCandidates(['normal.txt'], { root, confirmPhrase: 'QUARANTINE' }),
      /not an audited cleanup candidate/
    );
    await assert.rejects(
      quarantineMaintenanceCandidates(['normal.txt'], { root, confirmPhrase: 'wrong' }),
      /Confirmation phrase/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
