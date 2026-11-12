import { createError, getValidatedRouterParams } from 'h3';

import Database from '#server/utils/Database';
import WireGuard from '#server/utils/WireGuard';
import { definePermissionEventHandler } from '#server/utils/handler';
import { validateZod } from '#server/utils/types';
import { USER_ADMIN_ERRORS, UserAdminError } from '#server/utils/userAdmin';
import { UserGetSchema } from '#db/repositories/user/types';

/**
 * Delete a user and all of their clients
 */
export default definePermissionEventHandler(
  'users',
  'update',
  async ({ event, user }) => {
    const { userId } = await getValidatedRouterParams(
      event,
      validateZod(UserGetSchema, event)
    );

    try {
      const { deletedClients } = await Database.users.adminDelete(
        user.id,
        userId
      );

      // peers of deleted users are removed from the server config
      await WireGuard.saveConfig();

      return { success: true as const, deletedClients };
    } catch (err) {
      if (err instanceof UserAdminError) {
        const { statusCode, message } = USER_ADMIN_ERRORS[err.code];
        throw createError({ statusCode, statusMessage: message, message });
      }
      throw err;
    }
  }
);
