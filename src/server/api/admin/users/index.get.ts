import { setHeader } from 'h3';

import Database from '#server/utils/Database';
import { definePermissionEventHandler } from '#server/utils/handler';
import { matchAdminGroups } from '#server/utils/oidcRole';
import { getEffectiveOidcRoleMapping } from '#server/utils/oidcRuntime';
import { roleKey } from '#server/utils/userAdmin';

/**
 * All users for the admin panel (no secrets)
 */
export default definePermissionEventHandler(
  'users',
  'view',
  async ({ event, user }) => {
    setHeader(event, 'Cache-Control', 'no-store');

    const [users, roleMapping] = await Promise.all([
      Database.users.listWithStats(),
      getEffectiveOidcRoleMapping(),
    ]);

    return {
      adminGroupsConfigured: roleMapping.adminGroups.length > 0,
      users: users.map((u) => ({
        ...u,
        role: roleKey(u.role),
        isSelf: u.id === user.id,
        matchedAdminGroups: u.oidcGroups
          ? matchAdminGroups(u.oidcGroups, roleMapping.adminGroups)
          : [],
      })),
    };
  }
);
