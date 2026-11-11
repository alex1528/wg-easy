import { getValidatedRouterParams, readValidatedBody } from 'h3';

import Database from '#server/utils/Database';
import WireGuard from '#server/utils/WireGuard';
import { definePermissionEventHandler } from '#server/utils/handler';
import { validateZod } from '#server/utils/types';
import { hasPermissions } from '#shared/utils/permissions';
import {
  ClientGetSchema,
  ClientSelfUpdateSchema,
  ClientUpdateSchema,
} from '#db/repositories/client/types';

export default definePermissionEventHandler(
  'clients',
  'update',
  async ({ event, user, checkPermissions }) => {
    const { clientId } = await getValidatedRouterParams(
      event,
      validateZod(ClientGetSchema, event)
    );

    const client = await Database.clients.get(clientId);
    checkPermissions(client);

    if (hasPermissions(user, 'clients', 'updateAdvanced')) {
      const data = await readValidatedBody(
        event,
        validateZod(ClientUpdateSchema, event)
      );
      await Database.clients.update(clientId, data);
    } else {
      // non admin users can only rename their clients,
      // every other field is ignored
      const { name } = await readValidatedBody(
        event,
        validateZod(ClientSelfUpdateSchema, event)
      );
      await Database.clients.updateName(clientId, name);
    }

    await WireGuard.saveConfig();

    return { success: true };
  }
);
