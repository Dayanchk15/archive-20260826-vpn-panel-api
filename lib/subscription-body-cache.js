/** Short in-process cache for live subscription link bodies (per user). */

const DEFAULT_TTL_MS = Math.max(5_000, Number(process.env.SUBSCRIPTION_BODY_CACHE_TTL_MS || 45_000));
const cache = new Map();

export function getCachedSubscriptionLinks(userId) {
  const id = String(userId || '').trim();
  if (!id) return null;
  const hit = cache.get(id);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(id);
    return null;
  }
  return hit.body;
}

export function setCachedSubscriptionLinks(userId, body, ttlMs = DEFAULT_TTL_MS) {
  const id = String(userId || '').trim();
  if (!id) return;
  cache.set(id, {
    body: String(body || ''),
    expiresAt: Date.now() + Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS),
  });
}

export function invalidateSubscriptionBodyCache(userId) {
  const id = String(userId || '').trim();
  if (!id) {
    cache.clear();
    return;
  }
  cache.delete(id);
}
