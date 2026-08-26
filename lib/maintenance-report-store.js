import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REPORT_PATH = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'maintenance-server-reports.json');
let writeChain = Promise.resolve();

async function readStore() {
  try {
    const value = JSON.parse(await readFile(REPORT_PATH, 'utf8'));
    return value && typeof value === 'object' ? value : { reports: {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { reports: {} };
    throw err;
  }
}

export async function listMaintenanceReports() {
  const store = await readStore();
  return Object.values(store.reports || {});
}

export function saveMaintenanceReport(edgeId, snapshot) {
  const operation = writeChain.then(async () => {
    const id = String(edgeId || '').trim();
    if (!/^[a-zA-Z0-9_-]{2,80}$/.test(id)) throw new Error('Invalid edge id');
    const store = await readStore();
    const report = {
      ...snapshot,
      edgeId: id,
      receivedAt: new Date().toISOString(),
      readOnly: true,
    };
    store.reports = { ...(store.reports || {}), [id]: report };
    store.updatedAt = report.receivedAt;
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    const temporary = `${REPORT_PATH}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(store, null, 2), 'utf8');
    await rename(temporary, REPORT_PATH);
    return report;
  });
  writeChain = operation.catch(() => {});
  return operation;
}
