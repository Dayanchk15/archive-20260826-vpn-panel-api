import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { auditRepositoryJunk } from './repository-maintenance-audit.js';

const QUARANTINE_DIRECTORY = join('backup', 'maintenance-quarantine');

function safeRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe maintenance path: ${value}`);
  }
  return normalized;
}

function resolveInside(root, repositoryPath) {
  const absolute = resolve(root, safeRelativePath(repositoryPath));
  const prefix = `${resolve(root)}${sep}`;
  if (!absolute.startsWith(prefix)) throw new Error(`Path escapes maintenance root: ${repositoryPath}`);
  return absolute;
}

export async function quarantineMaintenanceCandidates(paths, options = {}) {
  if (options.confirmPhrase !== 'QUARANTINE') throw new Error('Confirmation phrase QUARANTINE is required');
  const root = resolve(options.root || process.cwd());
  const selected = [...new Set((Array.isArray(paths) ? paths : []).map(safeRelativePath))];
  if (!selected.length || selected.length > 200) throw new Error('Select between 1 and 200 files');

  const audit = await auditRepositoryJunk({ root, maxItems: 500 });
  const allowed = new Set(audit.candidates.map((item) => item.path));
  for (const repositoryPath of selected) {
    if (!allowed.has(repositoryPath)) throw new Error(`File is not an audited cleanup candidate: ${repositoryPath}`);
    const info = await lstat(resolveInside(root, repositoryPath));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Only regular files can be quarantined: ${repositoryPath}`);
  }

  const jobId = `q-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const jobRoot = resolve(root, QUARANTINE_DIRECTORY, jobId);
  const moved = [];
  const manifest = {
    id: jobId,
    type: 'repository-quarantine',
    status: 'completed',
    createdAt: new Date().toISOString(),
    restoredAt: null,
    files: selected,
    protections: { permanentlyDeleted: false, remoteServersContacted: false, clientsAffected: false },
  };
  await mkdir(jobRoot, { recursive: true });
  try {
    for (const repositoryPath of selected) {
      const source = resolveInside(root, repositoryPath);
      const target = resolveInside(jobRoot, repositoryPath);
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
      moved.push(repositoryPath);
    }
    await writeFile(join(jobRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    for (const repositoryPath of moved.reverse()) {
      const source = resolveInside(jobRoot, repositoryPath);
      const target = resolveInside(root, repositoryPath);
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target).catch(() => {});
    }
    throw err;
  }
  return manifest;
}

async function readManifest(root, jobId) {
  if (!/^q-[a-zA-Z0-9-]+$/.test(String(jobId || ''))) throw new Error('Invalid quarantine job id');
  const jobRoot = resolve(root, QUARANTINE_DIRECTORY, jobId);
  const manifest = JSON.parse(await readFile(join(jobRoot, 'manifest.json'), 'utf8'));
  return { jobRoot, manifest };
}

export async function restoreMaintenanceQuarantine(jobId, options = {}) {
  if (options.confirmPhrase !== 'RESTORE') throw new Error('Confirmation phrase RESTORE is required');
  const root = resolve(options.root || process.cwd());
  const { jobRoot, manifest } = await readManifest(root, jobId);
  if (manifest.restoredAt) return manifest;
  for (const repositoryPath of manifest.files || []) {
    const target = resolveInside(root, repositoryPath);
    try {
      await lstat(target);
      throw new Error(`Restore target already exists: ${repositoryPath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  const restored = [];
  try {
    for (const repositoryPath of manifest.files || []) {
      const source = resolveInside(jobRoot, repositoryPath);
      const target = resolveInside(root, repositoryPath);
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
      restored.push(repositoryPath);
    }
    manifest.status = 'restored';
    manifest.restoredAt = new Date().toISOString();
    await writeFile(join(jobRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err) {
    for (const repositoryPath of restored.reverse()) {
      const source = resolveInside(root, repositoryPath);
      const target = resolveInside(jobRoot, repositoryPath);
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target).catch(() => {});
    }
    throw err;
  }
  return manifest;
}

export async function listMaintenanceQuarantines(options = {}) {
  const root = resolve(options.root || process.cwd());
  const base = resolve(root, QUARANTINE_DIRECTORY);
  let entries = [];
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^q-[a-zA-Z0-9-]+$/.test(entry.name)) continue;
    try {
      const { manifest } = await readManifest(root, entry.name);
      jobs.push(manifest);
    } catch {}
  }
  return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export const maintenanceQuarantineInternals = { safeRelativePath, resolveInside };
