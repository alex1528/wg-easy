import { defineCommand } from 'citty';
import { consola } from 'consola';

import { db } from '#cli/db';
import { roles } from '#shared/utils/permissions';

export default defineCommand({
  meta: {
    name: 'db:user:list',
    description: 'List all users with their role',
  },
  async run() {
    const users = await db.query.user.findMany({
      columns: {
        id: true,
        username: true,
        email: true,
        role: true,
        roleSource: true,
        enabled: true,
        oauthProvider: true,
        lastLoginAt: true,
      },
      orderBy: (t, { asc }) => asc(t.id),
    });

    if (users.length === 0) {
      consola.info('No users found');
      return;
    }

    console.table(
      users.map((u) => ({
        ...u,
        role: u.role === roles.ADMIN ? 'ADMIN' : 'CLIENT',
      }))
    );
  },
});
