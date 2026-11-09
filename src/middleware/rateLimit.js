/**
 * Lightweight, zero-dependency sliding-window rate limiter middleware.
 * Protects authentication, OTP verification, and password reset endpoints
 * against brute-force attacks in production.
 */
function createRateLimiter({
  windowMs = 10 * 60 * 1000,
  max = 10,
  message = 'Trop de tentatives. Veuillez réessayer dans quelques minutes.',
  keyGenerator,
} = {}) {
  const hits = new Map();

  // Periodic cleanup of expired buckets so memory never grows unbounded
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (now >= entry.resetAt) {
        hits.delete(key);
      }
    }
  }, Math.min(windowMs, 60_000));

  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const rawKey = keyGenerator
      ? keyGenerator(req)
      : `${req.ip || req.headers['x-forwarded-for'] || 'ip'}:${(req.body?.email || '').toLowerCase()}`;

    let entry = hits.get(rawKey);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(rawKey, entry);
    }

    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: message });
    }

    return next();
  };
}

module.exports = { createRateLimiter };

