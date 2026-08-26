import { Router } from 'express';
import { getUserById, listUsers } from '../lib/db-store.js';
import { incrementNodeTrafficUsageBytes, incrementTrafficUsageBytes, setNodeTrafficUsageBytes, setTrafficUsageBytes } from '../lib/traffic-usage.js';
import { enforceUserLimits } from '../lib/user-enforcement.js';
import { buildEdgeClientList } from '../lib/edge-clients.js';
import { clientsFingerprint } from '../lib/relay-edge-sync.js';
import { nowIso } from '../lib/dates.js';
import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { saveMaintenanceReport } from '../lib/maintenance-report-store.js';

const TM_PROBE_PATH = path.join(
  process.env.LOCAL_STORAGE_DIR || '/data/files',
  'tm-probe-reports.json'
);

const router = Router();

function isAuthorized(req) {
  const edgeKey = process.env.EDGE_REPORT_KEY || '';
  const adminKey = process.env.ADMIN_API_KEY || '';
  const provided = req.get('x-edge-report-key') || req.get('x-admin-key') || '';
  if (!provided) return false;
  if (edgeKey && provided === edgeKey) return true;
  if (!edgeKey && adminKey && provided === adminKey) return true;
  return false;
}

function isEdgeSyncAuthorized(req) {
  const syncKey = process.env.EDGE_SYNC_KEY || process.env.EDGE_REPORT_KEY || '';
  const provided = req.get('x-edge-sync-key') || req.get('x-edge-report-key') || '';
  return Boolean(syncKey && provided === syncKey);
}

async function resolveUserId(input = {}) {
  if (input.userId && await getUserById(input.userId)) return input.userId;

  const uuid = String(input.uuid || '').trim().toLowerCase();
  const email = String(input.email || '').trim();
  const userIdFromEmail = email.match(/^user-(.+)$/)?.[1] || '';

  if (userIdFromEmail && await getUserById(userIdFromEmail)) return userIdFromEmail;
  if (!uuid && !email) return null;

  const users = await listUsers();
  const match = users.find((user) => {
    if (uuid && String(user.uuid || '').trim().toLowerCase() === uuid) return true;
    if (email && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(email)) {
      if (String(user.uuid || '').trim().toLowerCase() === email.toLowerCase()) return true;
    }
    if (email && String(user.email || '').trim() === email) return true;
    return false;
  });
  if (match?.id) return match.id;

  if (email) {
    const normalizedName = email.toLowerCase();
    const nameMatches = users.filter(
      (user) => String(user.name || '').trim().toLowerCase() === normalizedName
    );
    if (nameMatches.length === 1) return nameMatches[0].id;
  }

  return null;
}

router.get('/edge/clients', async (_req, res) => {
  try {
    if (!isEdgeSyncAuthorized(_req)) return res.status(401).json({ error: 'Unauthorized' });
    const clients = await buildEdgeClientList();
    const fingerprint = clientsFingerprint(clients);
    res.json({
      ok: true,
      fingerprint,
      clientCount: clients.length,
      clients,
      updatedAt: nowIso(),
    });
  } catch (err) {
    console.error('GET /internal/edge/clients error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/edge/maintenance', async (req, res) => {
  try {
    if (!isEdgeSyncAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const edgeId = req.body?.edgeId || req.get('x-edge-node-id');
    const snapshot = req.body?.snapshot;
    if (!snapshot || snapshot.readOnly !== true) return res.status(400).json({ error: 'Read-only snapshot required' });
    const report = await saveMaintenanceReport(edgeId, snapshot);
    res.json({ ok: true, edgeId: report.edgeId, receivedAt: report.receivedAt });
  } catch (err) {
    console.error('POST /internal/edge/maintenance error:', err);
    res.status(400).json({ error: err.message || 'Maintenance report rejected' });
  }
});

router.post('/traffic/report', async (req, res) => {
  try {
    if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

    const reports = Array.isArray(req.body?.reports) ? req.body.reports : [req.body || {}];
    const mode = req.body?.mode === 'increment' ? 'increment' : 'set';
    const results = [];

    for (const report of reports) {
      const userId = await resolveUserId(report);
      if (!userId) {
        results.push({ ok: false, error: 'user not found', email: report.email || null, uuid: report.uuid || null });
        continue;
      }

      const payload = {
        uploadBytes: report.uploadBytes ?? report.upload ?? 0,
        downloadBytes: report.downloadBytes ?? report.download ?? 0,
      };
      const nodeId = report.nodeId || req.body?.nodeId || req.get('x-edge-node-id') || '';
      const write = mode === 'increment'
        ? nodeId
          ? await incrementNodeTrafficUsageBytes(userId, nodeId, payload)
          : await incrementTrafficUsageBytes(userId, payload)
        : nodeId
          ? await setNodeTrafficUsageBytes(userId, nodeId, payload)
          : await setTrafficUsageBytes(userId, payload);
      const enforcement = await enforceUserLimits(userId);
      results.push({ ok: write.ok, userId, enforcement });
    }

    res.json({ ok: results.every((item) => item.ok), results });
  } catch (err) {
    console.error('POST /internal/traffic/report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/tm-probe/report', async (req, res) => {
  try {
    if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

    const report = {
      receivedAt: nowIso(),
      source: String(req.body?.source || 'tm-client').trim(),
      client: String(req.body?.client || 'happ').trim(),
      userId: String(req.body?.userId || '').trim() || null,
      lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
      summary: req.body?.summary && typeof req.body.summary === 'object' ? req.body.summary : {},
    };

    let store = { updatedAt: null, reports: [] };
    try {
      if (existsSync(TM_PROBE_PATH)) {
        store = JSON.parse(await readFile(TM_PROBE_PATH, 'utf8'));
      }
    } catch {
      store = { updatedAt: null, reports: [] };
    }

    const reports = Array.isArray(store.reports) ? store.reports : [];
    reports.unshift(report);
    store.reports = reports.slice(0, 200);
    store.updatedAt = nowIso();

    await mkdir(path.dirname(TM_PROBE_PATH), { recursive: true });
    await writeFile(TM_PROBE_PATH, JSON.stringify(store, null, 2), 'utf8');

    res.json({ ok: true, stored: store.reports.length, updatedAt: store.updatedAt });
  } catch (err) {
    console.error('POST /internal/tm-probe/report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
