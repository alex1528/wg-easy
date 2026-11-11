import { defineCommand } from 'citty';
import { consola } from 'consola';
import { eq } from 'drizzle-orm';

import { db, schema } from '#cli/db';
import { roles } from '#shared/utils/permissions';

/**
 * Recovery: make a user admin again (e.g. every admin was locked out)
 */
export default defineCommand({
  meta: {
    name: 'db:user:promote',
    description:
      'Make a user an enabled admin (manual role, not changed by OIDC groups)',
  },
  args: {
    username: {
      type: 'string',
      description: 'Username of the user to promote',
      required: true,
    },
  },
  async run(ctx) {
    const username = ctx.args.username;

    const user = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.username, username))
      .get();

    if (!user) {
      consola.error(`User ${username} not found. See db:user:list`);
      return;
    }

    await db
      .update(schema.user)
      .set({ role: roles.ADMIN, roleSource: 'manual', enabled: true })
      .where(eq(schema.user.id, user.id));

    console.info(
      `User change: target=${user.id}(${JSON.stringify(user.username)}) by=cli role=ADMIN roleSource=manual enabled=true`
    );
    consola.success(`User ${user.id} (${user.username}) is now an admin`);
  },
});
