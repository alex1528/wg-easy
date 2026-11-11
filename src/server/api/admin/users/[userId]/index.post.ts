import { createError, getValidatedRouterParams, readValidatedBody } from 'h3';

import Database from '#server/utils/Database';
import WireGuard from '#server/utils/WireGuard';
import { definePermissionEventHandler } from '#server/utils/handler';
import { getEffectiveOidcRoleMapping } from '#server/utils/oidcRuntime';
import { validateZod } from '#server/utils/types';
import {
  USER_ADMIN_ERRORS,
  UserAdminError,
  logUserChange,
} from '#server/utils/userAdmin';
import {
  UserAdminUpdateSchema,
  UserGetSchema,
} from '#db/repositories/user/types';

/**
 * Change the role / role source / enabled state of a user
 */
export default definePermissionEventHandler(
  'users',
  'update',
  async ({ event, user }) => {
    const { userId } = await getValidatedRouterParams(
      event,
      validateZod(UserGetSchema, event)
    );
    const change = await readValidatedBody(
      event,
      validateZod(UserAdminUpdateSchema, event)
    );

    const roleMapping = await getEffectiveOidcRoleMapping();

    try {
      const { before, after } = await Database.users.adminUpdate(
        user.id,
        userId,
        change,
        roleMapping.adminGroups
      );

      logUserChange(user, before, after);

      // peers of disabled users are removed from the server config
      if (before.enabled !== after.enabled) {
        await WireGuard.saveConfig();
      }

      return { success: true as const };
    } catch (err) {
      if (err instanceof UserAdminError) {
        const { statusCode, message } = USER_ADMIN_ERRORS[err.code];
        throw createError({ statusCode, statusMessage: message, message });
      }
      throw err;
    }
  }
);
