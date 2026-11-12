import { sha256 } from 'js-sha256';

/**
 * Compute a strong ETag (quoted) from a response body.
 * The body must be serialized deterministically (fixed key order).
 */
export function computeETag(body: string): string {
  return `"${sha256(body).slice(0, 32)}"`;
}

/**
 * Compare If-None-Match with the current ETag byte by byte.
 * Clients echo the ETag header value back verbatim (quotes included).
 */
export function etagMatches(
  ifNoneMatch: string | undefined,
  etag: string
): boolean {
  if (!ifNoneMatch) {
    return false;
  }

  // multiple etags are comma separated; `*` matches any
  return ifNoneMatch
    .split(',')
    .some((candidate) => candidate.trim() === etag || candidate.trim() === '*');
}
