import { getRequestURL } from 'h3';
import { defineNitroPlugin } from 'nitropack/runtime';

/**
 * Development only: one readable line per failed request.
 *
 * The dev error page resolves source maps for every error; when that fails
 * (`ERROR unreachable` from source-map) the actual request and status are
 * not visible in the log. This line always shows them.
 */
export default defineNitroPlugin((nitroApp) => {
  if (!import.meta.dev) return;

  nitroApp.hooks.hook('error', (error, { event }) => {
    if (!event) return;
    const err = error as Error & {
      statusCode?: number;
      statusMessage?: string;
    };
    const status = err.statusCode ?? 500;
    const url = getRequestURL(event);
    console.warn(
      `[request failed] ${event.method} ${url.pathname}${url.search} -> ${status} ${err.statusMessage ?? err.message}`
    );
  });
});
