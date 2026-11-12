import { createError, readValidatedBody } from 'h3';

import Database from '#server/utils/Database';
import { definePermissionEventHandler } from '#server/utils/handler';
import { validateZod } from '#server/utils/types';
import { roles } from '#shared/utils/permissions';
import {
  UserAdminCreateSchema,
  type UserType,
} from '#db/repositories/user/types';

/**
 * Create a new user (username + password login)
 */
export default definePermissionEventHandler(
  'users',
  'update',
  async ({ event, user }) => {
    const body = await readValidatedBody(
      event,
      validateZod(UserAdminCreateSchema, event)
    );

    try {
      await Database.users.create(
        body.username,
        body.password,
        body.name ?? null,
        body.role === 'ADMIN' ? roles.ADMIN : roles.CLIENT
      );
    } catch (err) {
      if (err instanceof Error && err.message === 'User already exists') {
        throw createError({
          statusCode: 409,
          statusMessage: 'User already exists',
          message: 'User already exists',
        });
      }
      throw err;
    }

    const created = await Database.users.getByUsername(body.username);
    console.info(
      `User change: target=${created?.id}(${JSON.stringify(body.username)}) by=user=${user.id} created (role=${body.role})`
    );

    const safe: Partial<UserType> | undefined = created
      ? { ...created, password: undefined }
      : undefined;
    return { success: true as const, user: safe };
  }
);
