import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const DEFAULT_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'backup']);
const TEMPORARY_NAME = /^(?:tmp-|_tmp)/i;
const GENERATED_EXTENSIONS = new Set(['.bin']);

export async function auditRepositoryJunk(options = {}) {
  const root = resolve(options.root || process.cwd());
  const maxItems = Math.min(500, Math.max(1, Number(options.maxItems || 200)));
  const candidates = [];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) continue;

      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const repositoryPath = relative(root, absolutePath).split(sep).join('/');
      const extension = extname(entry.name).toLowerCase();
      let reason = null;
      if (TEMPORARY_NAME.test(entry.name)) reason = 'temporary-name';
      else if (GENERATED_EXTENSIONS.has(extension)) reason = 'generated-binary';
      if (!reason) continue;

      const info = await stat(absolutePath);
      candidates.push({
        path: repositoryPath,
        reason,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
  }

  await walk(root);
  candidates.sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path));
  const totalBytes = candidates.reduce((sum, item) => sum + item.sizeBytes, 0);

  return {
    ok: true,
    readOnly: true,
    checkedAt: new Date().toISOString(),
    scope: 'panel-host-repository',
    summary: {
      candidates: candidates.length,
      totalBytes,
      totalMiB: Number((totalBytes / 1024 / 1024).toFixed(2)),
      shown: Math.min(candidates.length, maxItems),
    },
    candidates: candidates.slice(0, maxItems),
    protections: {
      filesModified: false,
      filesDeleted: false,
      remoteServersContacted: false,
      clientsAffected: false,
    },
  };
}
