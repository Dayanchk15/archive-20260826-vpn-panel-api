const buckets = new Map();

function clientIp(req) {
  return String(req.ip || req.connection?.remoteAddress || 'unknown');
}

export function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 5,
  keyFn = clientIp,
  message = 'Too many attempts. Try again later.',
} = {}) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
