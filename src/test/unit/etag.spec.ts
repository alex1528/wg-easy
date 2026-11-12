import { describe, expect, test } from 'vitest';

import { computeETag, etagMatches } from '#server/utils/etag';

describe('computeETag', () => {
  test('returns a quoted strong etag', () => {
    const etag = computeETag('body');
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test('is stable for the same body', () => {
    expect(computeETag('same')).toBe(computeETag('same'));
  });

  test('differs for different bodies', () => {
    expect(computeETag('a')).not.toBe(computeETag('b'));
  });
});

describe('etagMatches', () => {
  const etag = '"abc123"';

  test('matches the exact etag echoed back verbatim', () => {
    expect(etagMatches(etag, etag)).toBe(true);
  });

  test('matches within a comma separated list', () => {
    expect(etagMatches('"x", "abc123"', etag)).toBe(true);
  });

  test('does not match without quotes', () => {
    expect(etagMatches('abc123', etag)).toBe(false);
  });

  test('does not match a different etag', () => {
    expect(etagMatches('"other"', etag)).toBe(false);
  });

  test('matches the * wildcard', () => {
    expect(etagMatches('*', etag)).toBe(true);
  });

  test('does not match when the header is missing', () => {
    expect(etagMatches(undefined, etag)).toBe(false);
  });
});
