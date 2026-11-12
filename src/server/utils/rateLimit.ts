type Opts = {
  /** window size in milliseconds */
  windowMs: number;
  /** max requests per window */
  max: number;
};

type RateLimitResult = {
  allowed: boolean;
  /** seconds until the window resets (for the Retry-After header) */
  retryAfterSeconds: number;
};

/**
 * Simple in-memory fixed window rate limiter (sufficient for the
 * single-process docker deployment of wg-easy)
 */
export function createRateLimiter(opts: Opts) {
  const hits = new Map<string, { count: number; windowStart: number }>();

  return {
    check(key: string): RateLimitResult {
      const now = Date.now();

      const entry = hits.get(key);
      if (!entry || entry.windowStart + opts.windowMs <= now) {
        hits.set(key, { count: 1, windowStart: now });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      entry.count++;

      if (entry.count > opts.max) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil(
            (entry.windowStart + opts.windowMs - now) / 1000
          ),
        };
      }

      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
