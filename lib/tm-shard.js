import { createHash } from 'crypto';
import { isDayanchVipUser } from './vip-users.js';
import { DAYANCH_RELAY_SERVER_IDS } from './vip-users.js';

/**
 * Canonical TM shard order: EU media-first, USA last.
 * Each entry is alias group — first ID present in panel wins.
 */
export const TM_SHARD_CANONICAL_ORDER = [
  ['relay-eu-nl'], ['relay-eu-am'], ['relay-eu-de'], ['relay-eu-de2'],
  ['relay-eu-gb'], ['relay-eu-fr1'], ['relay-eu-fr2'], ['glb-vps-1'],
];

/** Tail servers appended after canonical pool (lower priority for TM video). */
const TM_TAIL_PRIORITY = new Set(['glb-vps-1', 'relay-eu-fr1', 'relay-eu-fr2']);

export function tmShardEnabled(panel = {}) {
  if (panel.subscriptionTmShardEnabled === false) return false;
  if (process.env.SUBSCRIPTION_TM_SHARD_ENABLED === '0') return false;
  return true;
}

export function hashUserShardIndex(userId, poolSize) {
  const size = Math.max(1, Number(poolSize) || 1);
  const digest = createHash('sha256').update(String(userId || '').trim()).digest();
  const value = digest.readUInt32BE(0);
  return value % size;
}

export function resolveShardPoolFromAvailable(availableIds) {
  const available = new Set((Array.isArray(availableIds) ? availableIds : []).map(String).filter(Boolean));
  const pool = [];
  const used = new Set();

  for (const aliases of TM_SHARD_CANONICAL_ORDER) {
    const hit = aliases.find((id) => available.has(id));
    if (hit && !used.has(hit)) {
      pool.push(hit);
      used.add(hit);
    }
  }

  const tail = [];
  const head = [];
  for (const id of available) {
    if (used.has(id)) continue;
    if (TM_TAIL_PRIORITY.has(id)) tail.push(id);
    else head.push(id);
  }
  head.sort();
  tail.sort();
  return [...pool, ...head, ...tail];
}

export function buildShardedBonusServerIds(userId, availableIds, options = {}) {
  const pool = resolveShardPoolFromAvailable(availableIds);
  if (!pool.length) return [];

  if (options.skipShard || options.preserveOrder) {
    return [...pool];
  }

  const index = hashUserShardIndex(userId, pool.length);
  const primary = pool[index];
  const rest = pool.filter((_, i) => i !== index);
  return [primary, ...rest];
}

export function shouldSkipTmShardForUser(user, panel = {}) {
  if (!tmShardEnabled(panel)) return true;
  if (isDayanchVipUser(user)) return true;
  if (user?.tmShardDisabled === true) return true;
  return false;
}

export function resolveTmBonusServerIds(user, availableIds, panel = {}) {
  if (isDayanchVipUser(user)) {
    const allowed = new Set((availableIds || []).map(String));
    return DAYANCH_RELAY_SERVER_IDS.filter((id) => allowed.has(id));
  }
  if (shouldSkipTmShardForUser(user, panel)) {
    return resolveShardPoolFromAvailable(availableIds);
  }
  return buildShardedBonusServerIds(user?.id, availableIds);
}

export function orderBonusServersByUser(user, servers, panel = {}) {
  const list = Array.isArray(servers) ? servers.filter(Boolean) : [];
  if (!list.length) return [];

  const userOrder = (Array.isArray(user?.bonusServerIds) ? user.bonusServerIds : [])
    .map(String)
    .filter(Boolean);

  if (tmShardEnabled(panel) && userOrder.length && !shouldSkipTmShardForUser(user, panel)) {
    const byId = new Map(list.map((s) => [String(s.id), s]));
    const ordered = [];
    for (const id of userOrder) {
      const server = byId.get(id);
      if (server) ordered.push(server);
    }
    for (const server of list) {
      if (!ordered.some((s) => s.id === server.id)) ordered.push(server);
    }
    return ordered;
  }

  return list;
}

export function dedupeIdsPreserveOrder(ids) {
  const seen = new Set();
  const out = [];
  for (const raw of ids || []) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function primaryBonusServerId(user) {
  return dedupeIdsPreserveOrder(user?.bonusServerIds)[0] || null;
}
