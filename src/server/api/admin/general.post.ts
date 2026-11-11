import { readValidatedBody } from 'h3';

import Database from '#server/utils/Database';
import { definePermissionEventHandler } from '#server/utils/handler';
import { validateZod } from '#server/utils/types';
import { GeneralUpdateRequestSchema } from '#db/repositories/general/types';

export default definePermissionEventHandler(
  'admin',
  'any',
  async ({ event }) => {
    const { liveWireGuardEndpointUrl, ...data } = await readValidatedBody(
      event,
      validateZod(GeneralUpdateRequestSchema, event)
    );
    await Database.general.update(data);

    // same setting as "Endpoint URL" in Admin Panel → OIDC
    if (liveWireGuardEndpointUrl !== undefined) {
      await Database.oidcSettings.updateEndpointUrl(liveWireGuardEndpointUrl);
    }

    return { success: true };
  }
);
