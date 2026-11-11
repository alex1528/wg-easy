import { createError, setHeader } from 'h3';

import Database from '#server/utils/Database';
import WireGuard from '#server/utils/WireGuard';
import {
  ClientLimitReachedError,
  clientLimitFor,
} from '#server/utils/clientLimit';
import { definePermissionEventHandler } from '#server/utils/handler';
import { createI18nError } from '#server/utils/i18nError';
import { createRateLimiter } from '#server/utils/rateLimit';
import { MaxClientsReachedError } from '#db/repositories/client/service';

// 5 new clients per minute per user
const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

/**
 * (Re)generate the connect client of the current user.
 * Always creates the client for the logged in user, regardless of role.
 * The previous clients are kept.
 * Non admin users are limited to "Max Clients per User" clients.
 */
export default definePermissionEventHandler(
  'me',
  'update',
  async ({ event, user, checkPermissions }) => {
    checkPermissions(user);

    const rate = rateLimiter.check(`user:${user.id}`);
    if (!rate.allowed) {
      setHeader(event, 'Retry-After', rate.retryAfterSeconds);
      throw createError({
        statusCode: 429,
        statusMessage: 'Too many requests',
      });
    }

    const limit = clientLimitFor(
      user,
      await Database.general.getMaxClientsPerUser()
    );

    try {
      const { clientId } = await Database.clients.createConnectClient(
        user,
        limit
      );
      await WireGuard.saveConfig();
      const client = await Database.clients.getConnectClient(user.id);
      return { success: true as const, clientId, client };
    } catch (err) {
      if (err instanceof ClientLimitReachedError) {
        throw await createI18nError(event, {
          statusCode: 409,
          statusMessage: 'Client limit reached',
          key: 'connect.limitReached',
          params: { max: err.limit },
          data: { limit: err.limit, count: err.count },
        });
      }
      if (err instanceof MaxClientsReachedError) {
        throw createError({
          statusCode: 409,
          statusMessage: 'No addresses available',
        });
      }
      throw err;
    }
  }
);
