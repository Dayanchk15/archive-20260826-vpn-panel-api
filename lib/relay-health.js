import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const DEFAULT_PATH = path.join(
  process.env.LOCAL_STORAGE_DIR || '/data/files',
  'relay-health.json'
);

/** Warm-first canonical primary order for TM (audit P1.1). */
export const TM_PRIMARY_SERVER_IDS = [
  'relay-eu-nl',
  'relay-eu-de',
  'relay-eu-fr1',
  'glb-vps-1',
];

export function healthStorePath() {
  return String(process.env.RELAY_HEALTH_PATH || DEFAULT_PATH).trim();
}

export async function loadRelayHealthStore() {
  const filePath = healthStorePath();
  try {
    if (!existsSync(filePath)) return { updatedAt: null, servers: {} };
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    return {
      updatedAt: raw.updatedAt || null,
      servers: raw.servers && typeof raw.servers === 'object' ? raw.servers : {},
    };
  } catch {
    return { updatedAt: null, servers: {} };
  }
}

export function computeHealthScore(entry = {}) {
  const ok = entry.ok === true;
  const ms = Number(entry.ms) || 0;
  const min = Number(entry.min) || 0;
  const fails = Number(entry.recentFails) || 0;

  let score = ok ? 100 : 0;
  if (ok && ms > 0) score -= Math.min(40, Math.floor(ms / 25));
  if (min >= 1) score += 8;
  score -= Math.min(30, fails * 10);
  return Math.max(0, Math.min(100, score));
}

export async function saveRelayHealthFromProbes(probes = []) {
  const store = await loadRelayHealthStore();
  const now = new Date().toISOString();
  const byId = { ...store.servers };

  for (const probe of probes) {
    if (!probe?.id || probe.pass === 'prewarm') continue;
    const id = String(probe.id);
    const prev = byId[id] || {};
    const ok = probe.ok === true;
    byId[id] = {
      id,
      ok,
      status: probe.status ?? null,
      ms: probe.ms ?? null,
      min: probe.min ?? prev.min ?? 0,
      error: probe.error || null,
      lastProbeAt: now,
      lastOkAt: ok ? now : prev.lastOkAt || null,
      lastFailAt: ok ? prev.lastFailAt || null : now,
      recentFails: ok ? 0 : Math.min(10, (Number(prev.recentFails) || 0) + 1),
      score: 0,
    };
    byId[id].score = computeHealthScore(byId[id]);
  }

  const filePath = healthStorePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({ updatedAt: now, servers: byId }, null, 2),
    'utf8'
  );
  return { updatedAt: now, servers: byId };
}

export function orderServersByHealthAndRole(servers, healthStore = {}, panel = {}) {
  const list = Array.isArray(servers) ? [...servers] : [];
  if (!list.length) return [];

  const health = healthStore.servers || {};
  const warmIds = new Set(
    list.filter((s) => Number(s.minInstances ?? 0) >= 1).map((s) => String(s.id))
  );

  const primaryCandidates = TM_PRIMARY_SERVER_IDS.filter((id) =>
    list.some((s) => String(s.id) === id)
  );
  const primarySet = new Set(primaryCandidates.slice(0, 3));

  function sortKey(server) {
    const id = String(server.id);
    const h = health[id] || {};
    const score = Number.isFinite(h.score) ? h.score : computeHealthScore({ ok: true, min: server.minInstances });
    const isPrimary = primarySet.has(id) ? 0 : 1;
    const isWarm = warmIds.has(id) ? 0 : 1;
    const idx = primaryCandidates.indexOf(id);
    const primaryOrder = idx >= 0 ? idx : 99;
    return [isPrimary, isWarm, -score, primaryOrder, String(server.sortOrder ?? 999), id];
  }

  list.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });

  return list.map((server, index) => {
    const id = String(server.id);
    const isPrimarySlot = index < 3 && (primarySet.has(id) || warmIds.has(id));
    return {
      server,
      health: health[id] || null,
      role: isPrimarySlot ? 'primary' : 'backup',
    };
  });
}

export function formatRemarkWithRole(baseRemark, _role, isUserPrimary) {
  const base = String(baseRemark || '').trim();
  if (isUserPrimary && !base.includes('⭐')) return `⭐ ${base}`;
  return base;
}
