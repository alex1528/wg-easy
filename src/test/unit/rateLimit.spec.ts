import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRateLimiter } from '#server/utils/rateLimit';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('allows up to max requests per window', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

    expect(limiter.check('ip1').allowed).toBe(true);
    expect(limiter.check('ip1').allowed).toBe(true);
    expect(limiter.check('ip1').allowed).toBe(true);
    expect(limiter.check('ip1').allowed).toBe(false);
  });

  test('keys are isolated', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

    expect(limiter.check('ip1').allowed).toBe(true);
    expect(limiter.check('ip1').allowed).toBe(false);
    expect(limiter.check('ip2').allowed).toBe(true);
  });

  test('reports retryAfterSeconds until the window resets', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

    limiter.check('ip1');
    vi.advanceTimersByTime(10_000);

    const result = limiter.check('ip1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(50);
  });

  test('allows again after the window passed', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

    limiter.check('ip1');
    vi.advanceTimersByTime(60_001);

    expect(limiter.check('ip1').allowed).toBe(true);
  });
});
