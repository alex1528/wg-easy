import { defineCommand } from 'citty';
import { consola } from 'consola';
import { asc, eq } from 'drizzle-orm';

import { db, schema } from '#cli/db';
import { hashPassword } from '#server/utils/password';
import { roles } from '#shared/utils/permissions';

export default defineCommand({
  meta: {
    name: 'db:admin:reset',
    description: 'Reset the password and TOTP settings of an admin user',
  },
  args: {
    password: {
      type: 'string',
      description: 'New password for the admin user',
      required: false,
    },
    username: {
      type: 'string',
      description: 'Admin user to reset (default: the oldest admin)',
      required: false,
    },
  },
  async run(ctx) {
    let password = ctx.args.password || undefined;
    if (!password) {
      password = await consola.prompt('Please enter a new password:', {
        type: 'text',
      });
    }
    if (!password) {
      consola.error('Password is required');
      return;
    }
    if (password.length < 12) {
      consola.error('Password must be at least 12 characters long');
      return;
    }
    consola.info('Setting new password for admin user...');
    const hash = await hashPassword(password);

    const user = await db.transaction(async (tx) => {
      const user = ctx.args.username
        ? await tx
            .select()
            .from(schema.user)
            .where(eq(schema.user.username, ctx.args.username))
            .get()
        : await tx
            .select()
            .from(schema.user)
            .where(eq(schema.user.role, roles.ADMIN))
            .orderBy(asc(schema.user.id))
            .limit(1)
            .get();

      if (!user) {
        consola.error(
          ctx.args.username
            ? `User ${ctx.args.username} not found`
            : 'Admin user not found. Use db:user:promote first.'
        );
        return;
      }

      if (user.role !== roles.ADMIN) {
        consola.error(
          `User ${user.username} is not an admin. Use db:user:promote first.`
        );
        return;
      }

      await tx
        .update(schema.user)
        .set({
          password: hash,
          totpVerified: false,
          totpKey: null,
          enabled: true,
        })
        .where(eq(schema.user.id, user.id));

      return user;
    });

    if (!user) {
      consola.error('Failed to update admin user');
      return;
    }

    consola.success(
      `Successfully updated admin user ${user.id} (${user.username})`
    );
  },
});
