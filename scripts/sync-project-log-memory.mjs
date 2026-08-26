#!/usr/bin/env node
/**
 * Синхронизация PROJECT_LOG.md между локальным ПК и VPS.
 * push — локальный → VPS (IDE → Telegram Desktop Agent)
 * pull — VPS → локальный (Telegram → IDE)
 */
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const localFile = path.join(root, 'PROJECT_LOG.md');

const VPS_HOST = process.env.VPS_HOST || '45.140.42.39';
const VPS_USER = process.env.VPS_USER || 'root';
const VPS_REMOTE = process.env.VPS_PROJECT_LOG_PATH || '/opt/vpn-panel/files/PROJECT_LOG.md';
const mode = process.argv[2] || 'push';

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', shell: true });
}

if (mode === 'push') {
  run(
    `scp -o StrictHostKeyChecking=no "${localFile}" ${VPS_USER}@${VPS_HOST}:${VPS_REMOTE}`
  );
  console.log(JSON.stringify({ ok: true, mode: 'push', local: localFile, remote: VPS_REMOTE }, null, 2));
} else if (mode === 'pull') {
  const tmp = `${localFile}.pull.tmp`;
  run(`scp -o StrictHostKeyChecking=no ${VPS_USER}@${VPS_HOST}:${VPS_REMOTE} "${tmp}"`);
  const content = await readFile(tmp, 'utf8');
  await writeFile(localFile, content, 'utf8');
  console.log(JSON.stringify({ ok: true, mode: 'pull', local: localFile }, null, 2));
} else {
  console.error('Usage: node scripts/sync-project-log-memory.mjs [push|pull]');
  process.exit(1);
}
