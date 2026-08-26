#!/usr/bin/env node
/**
 * Edge sync agent — hot-diff only, no container restart.
 * Control port :19222 (panel push + local status).
 */
import express from 'express';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { lstat, readFile, readdir, statfs } from 'fs/promises';
import { basename, dirname, join } from 'path';
import {
  applyClientDiff,
  listCurrentUsers,
  normalizeClientList,
} from '../vpn-edge/xray-client-diff.js';

const PORT = Number(process.env.AGENT_PORT || 19222);
const BIND_ADDR = String(process.env.AGENT_BIND_ADDR || '127.0.0.1').trim();
const SYNC_KEY = String(process.env.EDGE_SYNC_KEY || process.env.EDGE_REPORT_KEY || '').trim();
const EDGE_ID = String(process.env.EDGE_ID || 'unknown').trim();
const PANEL_PULL_URL = String(process.env.PANEL_PULL_URL || '').trim();
const PANEL_PULL_INTERVAL_MS = Math.max(5000, Number(process.env.PANEL_PULL_INTERVAL_MS || 15000));
const XRAY_VERIFY_INTERVAL_MS = Math.max(15000, Number(process.env.XRAY_VERIFY_INTERVAL_MS || 60000));
const MAINTENANCE_REPORT_INTERVAL_MS = Math.max(60000, Number(process.env.MAINTENANCE_REPORT_INTERVAL_MS || 300000));
const EDGE_ENV_FILE = process.env.EDGE_ENV_FILE || '/opt/vpn-relay-edge/.env';
const EDGE_MAINTENANCE_ROOT = process.env.EDGE_MAINTENANCE_ROOT || dirname(EDGE_ENV_FILE);

let lastFingerprint = null;
let lastAppliedAt = null;
let lastApplied = null;
let lastError = null;
let pullTimer = null;
let lastMaintenanceReportAt = 0;
let lastVerifiedAt = 0;

function clientsFingerprint(clients) {
  const uuids = clients
    .map((c) => String(c.uuid || '').trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return createHash('sha256').update(uuids.join(',')).digest('hex');
}

function isAuthorized(req) {
  if (!SYNC_KEY) return false;
  const provided = req.get('x-edge-sync-key') || req.get('x-edge-report-key') || '';
  return provided === SYNC_KEY;
}

function maintenanceFileReason(name) {
  if (/^(?:tmp-|_tmp)/i.test(name)) return 'temporary-name';
  if (/\.log\.\d+(?:\.gz)?$/i.test(name) || /\.(?:old|bak|gz)$/i.test(name)) return 'rotated-log-or-backup';
  if (/\.log$/i.test(name)) return 'active-log-review-only';
  return null;
}

async function scanMaintenanceFiles(root, limit = 2000) {
  const pending = [root];
  const candidates = [];
  let inspected = 0;
  while (pending.length && inspected < limit) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (inspected >= limit) break;
      inspected += 1;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const reason = maintenanceFileReason(entry.name);
      if (!reason) continue;
      try {
        const info = await lstat(absolutePath);
        candidates.push({ name: basename(absolutePath), reason, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
      } catch {}
    }
  }
  const totalBytes = candidates.reduce((sum, item) => sum + item.sizeBytes, 0);
  return { inspected, truncated: inspected >= limit, candidates: candidates.length, totalBytes };
}

async function readHostMaintenanceSnapshot() {
  const [disk, loadText, memText, uptimeText] = await Promise.all([
    statfs('/'),
    readFile('/proc/loadavg', 'utf8'),
    readFile('/proc/meminfo', 'utf8'),
    readFile('/proc/uptime', 'utf8'),
  ]);
  const files = await scanMaintenanceFiles(EDGE_MAINTENANCE_ROOT);
  const blockSize = Number(disk.bsize || 0);
  const totalBytes = Number(disk.blocks || 0) * blockSize;
  const freeBytes = Number(disk.bavail || 0) * blockSize;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const mem = Object.fromEntries(
    memText.split('\n').map((line) => line.match(/^([^:]+):\s+(\d+)/)).filter(Boolean).map((m) => [m[1], Number(m[2]) * 1024])
  );
  const load = loadText.trim().split(/\s+/).slice(0, 3).map(Number);
  return {
    checkedAt: new Date().toISOString(),
    readOnly: true,
    disk: {
      totalBytes,
      usedBytes,
      freeBytes,
      usedPercent: totalBytes ? Number(((usedBytes / totalBytes) * 100).toFixed(1)) : null,
    },
    memory: {
      totalBytes: mem.MemTotal ?? null,
      availableBytes: mem.MemAvailable ?? null,
      usedPercent: mem.MemTotal && mem.MemAvailable != null
        ? Number((((mem.MemTotal - mem.MemAvailable) / mem.MemTotal) * 100).toFixed(1))
        : null,
    },
    loadAverage: load,
    uptimeSeconds: Number.parseFloat(uptimeText) || null,
    files,
    capabilities: {
      analyze: true,
      cleanup: false,
      restart: false,
      dockerSocket: false,
    },
  };
}

function readEnvFingerprint() {
  try {
    const text = readFileSync(EDGE_ENV_FILE, 'utf8');
    const match = text.match(/^EDGE_SYNC_FINGERPRINT=(.*)$/m);
    return match ? String(match[1]).trim() : null;
  } catch {
    return null;
  }
}

function persistFingerprint(fingerprint) {
  try {
    let text = readFileSync(EDGE_ENV_FILE, 'utf8');
    const line = `EDGE_SYNC_FINGERPRINT=${fingerprint}`;
    if (/^EDGE_SYNC_FINGERPRINT=/m.test(text)) {
      text = text.replace(/^EDGE_SYNC_FINGERPRINT=.*$/m, line);
    } else {
      text = `${text.trim()}\n${line}\n`;
    }
    writeFileSync(EDGE_ENV_FILE, text, 'utf8');
  } catch {
    // non-fatal
  }
}

async function applyDesiredClients(clients, fingerprint) {
  const now = Date.now();
  if (
    fingerprint &&
    fingerprint === lastFingerprint &&
    now - lastVerifiedAt < XRAY_VERIFY_INTERVAL_MS
  ) {
    lastError = null;
    return { applied: false, skipped: true, fingerprint, clientCount: clients.length };
  }

  const result = await applyClientDiff(clients);
  lastVerifiedAt = now;
  lastFingerprint = fingerprint || clientsFingerprint(clients);
  lastAppliedAt = new Date().toISOString();
  lastApplied = result;
  lastError = result.ok === false ? `missing uuids: ${(result.missing || []).join(',')}` : null;
  persistFingerprint(lastFingerprint);
  return {
    ...result,
    fingerprint: lastFingerprint,
    clientCount: clients.length,
    sessionDropCount: 0,
    applyMode: 'hot-diff',
  };
}

async function pullFromPanel() {
  if (!PANEL_PULL_URL || !SYNC_KEY) return;
  try {
    const res = await fetch(PANEL_PULL_URL, {
      headers: { 'x-edge-sync-key': SYNC_KEY },
    });
    if (!res.ok) throw new Error(`pull HTTP ${res.status}`);
    const body = await res.json();
    const clients = normalizeClientList(body.clients || []);
    const fingerprint = body.fingerprint || clientsFingerprint(clients);
    await reportMaintenanceSnapshot().catch((err) => console.error(`[${EDGE_ID}] maintenance report:`, err.message));
    await applyDesiredClients(clients, fingerprint);
  } catch (err) {
    lastError = err.message || String(err);
    console.error(`[${EDGE_ID}] pull failed:`, lastError);
  }
}

function maintenanceReportUrl() {
  if (!PANEL_PULL_URL) return '';
  try {
    const url = new URL(PANEL_PULL_URL);
    url.pathname = url.pathname.replace(/\/edge\/clients\/?$/, '/edge/maintenance');
    return url.toString();
  } catch {
    return '';
  }
}

async function reportMaintenanceSnapshot() {
  const now = Date.now();
  if (!SYNC_KEY || now - lastMaintenanceReportAt < MAINTENANCE_REPORT_INTERVAL_MS) return;
  const url = maintenanceReportUrl();
  if (!url) return;
  const snapshot = await readHostMaintenanceSnapshot();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-edge-sync-key': SYNC_KEY, 'x-edge-node-id': EDGE_ID },
    body: JSON.stringify({ edgeId: EDGE_ID, snapshot }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  lastMaintenanceReportAt = now;
}

function startPullLoop() {
  if (!PANEL_PULL_URL) return;
  if (pullTimer) clearInterval(pullTimer);
  pullTimer = setInterval(() => {
    pullFromPanel().catch((err) => console.error(`[${EDGE_ID}] pull loop:`, err.message));
  }, PANEL_PULL_INTERVAL_MS);
  pullFromPanel().catch(() => {});
}

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, edgeId: EDGE_ID, applyMode: 'hot-diff' });
});

app.get('/v1/status', async (_req, res) => {
  const current = await listCurrentUsers().catch(() => []);
  res.json({
    ok: true,
    edgeId: EDGE_ID,
    isConnected: true,
    lastFingerprint,
    lastAppliedAt,
    lastApplied,
    lastError,
    lastVerifiedAt: lastVerifiedAt ? new Date(lastVerifiedAt).toISOString() : null,
    lastSessionDropCount: 0,
    clientCount: current.length,
    applyMode: 'hot-diff',
  });
});

app.get('/v1/maintenance', async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, edgeId: EDGE_ID, ...(await readHostMaintenanceSnapshot()) });
  } catch (err) {
    res.status(500).json({ ok: false, edgeId: EDGE_ID, readOnly: true, error: err.message || String(err) });
  }
});

app.post('/v1/clients', async (req, res) => {
  try {
    if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const clients = normalizeClientList(req.body?.clients || []);
    const fingerprint = req.body?.fingerprint || clientsFingerprint(clients);
    const result = await applyDesiredClients(clients, fingerprint);
    res.json({ ok: true, edgeId: EDGE_ID, ...result });
  } catch (err) {
    lastError = err.message || String(err);
    console.error(`[${EDGE_ID}] apply error:`, lastError);
    res.status(500).json({ ok: false, error: lastError, applyMode: 'hot-diff' });
  }
});

app.listen(PORT, BIND_ADDR, () => {
  console.log(`vpn-edge-sync-agent listening on ${BIND_ADDR}:${PORT} edge=${EDGE_ID}`);
  startPullLoop();
});
