type Opts = {
  /**
   * Expiry time in milliseconds
   */
  expiry: number;
};

/**
 * Cache the result of a function for the given expiry time in milliseconds
 */
export function cacheFunction<T>(fn: () => T, { expiry }: Opts): () => T {
  let cache: { value: T; expiry: number } | null = null;

  return (): T => {
    const now = Date.now();

    if (cache && cache.expiry > now) {
      return cache.value;
    }

    const result = fn();
    cache = {
      value: result,
      expiry: now + expiry,
    };

    return result;
  };
}

/**
 * Cache the result of an async function for the given expiry time in milliseconds.
 * Unlike {@link cacheFunction}, a rejected promise is not cached.
 */
export function cacheFunctionAsync<T>(
  fn: () => Promise<T>,
  { expiry }: Opts
): () => Promise<T> {
  let cache: { value: Promise<T>; expiry: number } | null = null;

  return async (): Promise<T> => {
    const now = Date.now();

    if (cache && cache.expiry > now) {
      return cache.value;
    }

    const result = fn();
    cache = {
      value: result,
      expiry: now + expiry,
    };

    try {
      return await result;
    } catch (err) {
      // don't cache failures
      cache = null;
      throw err;
    }
  };
}
