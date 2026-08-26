#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function gitFiles(patterns = []) {
  const result = spawnSync('git', ['ls-files', '-z', ...patterns], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git ls-files failed');
  return result.stdout.split('\0').filter(Boolean);
}

// Deleted files remain in the index until the change is committed; do not
// report those intentionally removed files as syntax failures.
const sourceFiles = gitFiles(['*.js', '*.mjs']).filter((file) => existsSync(file));
const failures = [];
for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file, error: (result.stderr || result.stdout).trim() });
}

const forbidden = gitFiles().filter((file) => {
  const name = file.split('/').pop();
  return /^(?:tmp-|_tmp)/i.test(name) || /\.bin$/i.test(name) || file === 'hostinger/config.php';
});

if (failures.length || forbidden.length) {
  console.error(JSON.stringify({ ok: false, syntaxFailures: failures, forbiddenTrackedFiles: forbidden }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, syntaxChecked: sourceFiles.length, forbiddenTrackedFiles: 0 }, null, 2));
