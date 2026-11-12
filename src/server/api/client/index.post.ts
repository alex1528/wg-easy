import { createError, readValidatedBody } from 'h3';

import Database from '#server/utils/Database';
import WireGuard from '#server/utils/WireGuard';
import { definePermissionEventHandler } from '#server/utils/handler';
import { validateZod } from '#server/utils/types';
import { ClientCreateWithOwnerSchema } from '#db/repositories/client/types';

export default definePermissionEventHandler(
  'clients',
  'create',
  async ({ event, user }) => {
    const { name, expiresAt, userId } = await readValidatedBody(
      event,
      validateZod(ClientCreateWithOwnerSchema, event)
    );

    // owner defaults to the admin creating the client
    let ownerId = user.id;
    if (userId !== undefined && userId !== user.id) {
      const owner = await Database.users.get(userId);
      if (!owner) {
        throw createError({
          statusCode: 400,
          statusMessage: 'Owner not found',
          message: 'Owner not found',
        });
      }
      ownerId = owner.id;
    }

    const result = await Database.clients.create({ name, expiresAt }, ownerId);
    await WireGuard.saveConfig();

    const clientId = result[0]!.clientId;
    return { success: true, clientId };
  }
);
