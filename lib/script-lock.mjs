import fs from 'node:fs';
import path from 'node:path';

const LOCK_DIR = process.env.SCRIPT_LOCK_DIR || '/data/files/locks';

export function acquireScriptLock(name, { staleMs = 2 * 60 * 60 * 1000 } = {}) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = path.join(LOCK_DIR, `${name}.lock`);

  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    /* no lock */
  }

  try {
    fs.writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}`, { flag: 'wx' });
    return {
      ok: true,
      lockPath,
      release() {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return { ok: false, lockPath };
  }
}

export function withScriptLock(name, fn, options = {}) {
  const lock = acquireScriptLock(name, options);
  if (!lock.ok) {
    console.log(JSON.stringify({ skipped: true, reason: 'lock held', lock: lock.lockPath }));
    process.exit(0);
  }
  const release = () => lock.release();
  process.on('exit', release);
  process.on('SIGINT', () => {
    release();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    release();
    process.exit(143);
  });
  return fn(release);
}
