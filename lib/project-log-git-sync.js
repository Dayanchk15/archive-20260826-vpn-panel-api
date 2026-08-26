import { execFile } from 'child_process';
import { promisify } from 'util';
import { copyFile, mkdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { resolveProjectLogPath } from './project-log-memory.js';

const execFileAsync = promisify(execFile);

export function projectLogGitSyncEnabled() {
  return process.env.PROJECT_LOG_GIT_SYNC_ENABLED !== 'false';
}

export function projectLogGitRoot() {
  return process.env.PROJECT_LOG_GIT_ROOT || path.dirname(resolveProjectLogPath());
}

function gitBranch() {
  return process.env.PROJECT_LOG_GIT_BRANCH || 'main';
}

function gitRemote() {
  return process.env.PROJECT_LOG_GIT_REMOTE || 'origin';
}

function repoLogPath(root) {
  return path.join(root, 'PROJECT_LOG.md');
}

async function runGit(args, { cwd } = {}) {
  const root = cwd || projectLogGitRoot();
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
  if (process.env.GIT_SSH_COMMAND) {
    env.GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND;
  }
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd: root,
    env,
    maxBuffer: 12 * 1024 * 1024,
  });
  return { stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
}

async function isGitRepo(root) {
  try {
    await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function ensureGitIdentity(root) {
  try {
    await runGit(['config', 'user.email'], { cwd: root });
  } catch {
    await runGit(
      ['config', 'user.email', process.env.PROJECT_LOG_GIT_EMAIL || 'desktop-agent@local'],
      { cwd: root }
    );
    await runGit(
      ['config', 'user.name', process.env.PROJECT_LOG_GIT_AUTHOR || 'Desktop Agent'],
      { cwd: root }
    );
  }
}

async function syncActiveLogIntoRepo(root) {
  const active = resolveProjectLogPath();
  const repoLog = repoLogPath(root);
  if (path.resolve(active) === path.resolve(repoLog)) return { copied: false, path: repoLog };
  try {
    await mkdir(path.dirname(repoLog), { recursive: true });
    await copyFile(active, repoLog);
    return { copied: true, path: repoLog };
  } catch (err) {
    if (err.code === 'ENOENT') return { copied: false, path: repoLog, missing: true };
    throw err;
  }
}

async function syncRepoLogToActive(root) {
  const active = resolveProjectLogPath();
  const repoLog = repoLogPath(root);
  if (path.resolve(active) === path.resolve(repoLog)) return { copied: false };
  try {
    await mkdir(path.dirname(active), { recursive: true });
    await copyFile(repoLog, active);
    return { copied: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { copied: false, missing: true };
    throw err;
  }
}

export async function pullProjectLogFromGit() {
  if (!projectLogGitSyncEnabled()) return { ok: true, skipped: true, reason: 'disabled' };

  const root = projectLogGitRoot();
  if (!(await isGitRepo(root))) {
    return { ok: false, error: `not a git repo: ${root}` };
  }

  await ensureGitIdentity(root);
  const remote = gitRemote();
  const branch = gitBranch();

  try {
    await runGit(['fetch', remote, branch], { cwd: root });
    await runGit(['merge', '--no-edit', `${remote}/${branch}`], { cwd: root });
  } catch (err) {
    const msg = err.stderr || err.message || String(err);
    if (/CONFLICT/.test(msg) || /conflict/i.test(msg)) {
      await runGit(['checkout', '--theirs', 'PROJECT_LOG.md'], { cwd: root }).catch(() => null);
      await runGit(['add', 'PROJECT_LOG.md'], { cwd: root });
      await runGit(['commit', '-m', 'memory: auto-merge PROJECT_LOG (remote wins on conflict)'], {
        cwd: root,
      }).catch(() => null);
    } else {
      throw err;
    }
  }

  await syncRepoLogToActive(root);
  return { ok: true, action: 'pull', root, branch };
}

export async function pushProjectLogToGit({ source = 'Desktop Agent' } = {}) {
  if (!projectLogGitSyncEnabled()) return { ok: true, skipped: true, reason: 'disabled' };

  const root = projectLogGitRoot();
  if (!(await isGitRepo(root))) {
    return { ok: false, error: `not a git repo: ${root}` };
  }

  await ensureGitIdentity(root);
  await syncActiveLogIntoRepo(root);

  const status = await runGit(['status', '--porcelain', 'PROJECT_LOG.md'], { cwd: root });
  if (!status.stdout) {
    return { ok: true, action: 'noop', reason: 'no changes' };
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const message = `memory: ${source} ${stamp}`;

  await runGit(['add', 'PROJECT_LOG.md'], { cwd: root });
  await runGit(['commit', '-m', message], { cwd: root });
  await runGit(['push', gitRemote(), gitBranch()], { cwd: root });

  return { ok: true, action: 'push', message, root };
}

export async function syncProjectLogGit({ phase = 'full', source } = {}) {
  const result = { phase, pull: null, push: null };
  try {
    result.pull = await pullProjectLogFromGit();
  } catch (err) {
    result.pull = { ok: false, error: err.message || String(err) };
  }

  if (phase === 'after-response' || phase === 'push' || phase === 'full') {
    try {
      result.push = await pushProjectLogToGit({ source });
    } catch (err) {
      result.push = { ok: false, error: err.message || String(err) };
    }
  }

  result.ok = Boolean(
    (result.pull?.ok || result.pull?.skipped) && (result.push?.ok || result.push?.skipped || phase === 'pull')
  );
  return result;
}

export async function projectLogGitHasLocalChanges() {
  const root = projectLogGitRoot();
  if (!(await isGitRepo(root))) return false;
  await syncActiveLogIntoRepo(root);
  const status = await runGit(['status', '--porcelain', 'PROJECT_LOG.md'], { cwd: root });
  return Boolean(status.stdout);
}

export async function getProjectLogGitMeta() {
  const root = projectLogGitRoot();
  const active = resolveProjectLogPath();
  let mtime = null;
  try {
    mtime = (await stat(active)).mtime.toISOString();
  } catch {
    // ignore
  }
  return {
    enabled: projectLogGitSyncEnabled(),
    root,
    activePath: active,
    branch: gitBranch(),
    remote: gitRemote(),
    isRepo: await isGitRepo(root),
    mtime,
  };
}
