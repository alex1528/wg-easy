import Database from '#server/utils/Database';
import { definePermissionEventHandler } from '#server/utils/handler';
import { getDefaultEndpointUrl } from '#server/utils/oidcSetup';

export default definePermissionEventHandler(
  'admin',
  'any',
  async ({ event }) => {
    const [generalConfig, oidcRow] = await Promise.all([
      Database.general.getConfig(),
      Database.oidcSettings.get(),
    ]);
    return {
      ...generalConfig,
      /** custom endpoint url, null = derived from the request host */
      liveWireGuardEndpointUrl: oidcRow?.endpointUrl ?? null,
      liveWireGuardEndpointDefault: getDefaultEndpointUrl(event),
    };
  }
);
