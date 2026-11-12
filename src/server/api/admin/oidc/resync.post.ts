import { createError } from 'h3';

import Database from '#server/utils/Database';
import { definePermissionEventHandler } from '#server/utils/handler';
import { getEffectiveOidcRoleMapping } from '#server/utils/oidcRuntime';
import { roleKey } from '#server/utils/userAdmin';

/**
 * Recalculate the role of every OIDC managed user from the groups of their
 * last OIDC login (e.g. after changing the admin groups)
 */
export default definePermissionEventHandler(
  'users',
  'update',
  async ({ user }) => {
    const roleMapping = await getEffectiveOidcRoleMapping();
    if (roleMapping.adminGroups.length === 0) {
      throw createError({
        statusCode: 400,
        statusMessage: 'No admin groups configured',
        message: 'No admin groups configured',
      });
    }

    const { changed, skipped } = await Database.users.resyncOidcRoles(
      roleMapping.adminGroups
    );

    for (const c of changed) {
      console.info(
        `User change: target=${c.id}(${JSON.stringify(c.username)}) by=user=${user.id}(${JSON.stringify(user.username)}) role=${roleKey(c.from)}->${roleKey(c.to)} (oidc resync)`
      );
    }

    return { success: true as const, changed: changed.length, skipped };
  }
);
