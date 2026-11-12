import { setHeader } from 'h3';

import Database from '#server/utils/Database';
import WireGuard from '#server/utils/WireGuard';
import { clientLimitFor, clientUsage } from '#server/utils/clientLimit';
import { definePermissionEventHandler } from '#server/utils/handler';
import { getSetupInfo } from '#server/utils/oidcSetup';

/**
 * Data for the two QR codes on the home page:
 * - setup: LiveWireGuard / OIDC setup payload (QR code A)
 * - client: the user's own connect client (QR code B)
 * Read only: never creates a client.
 */
export default definePermissionEventHandler(
  'me',
  'update',
  async ({ event, user, checkPermissions }) => {
    checkPermissions(user);
    setHeader(event, 'Cache-Control', 'no-store');

    const [setup, connectClient, maxClientsPerUser, clientCount] =
      await Promise.all([
        getSetupInfo(event),
        Database.clients.getConnectClient(user.id),
        Database.general.getMaxClientsPerUser(),
        Database.clients.countForUser(user.id),
      ]);

    /** null = unlimited (admins, or limit set to 0) */
    const limit = clientUsage(
      clientCount,
      clientLimitFor(user, maxClientsPerUser)
    );

    let client: {
      id: number;
      name: string;
      enabled: boolean;
      revision: string;
    } | null = null;

    if (connectClient) {
      const revision = await WireGuard.getClientConfigRevision({
        clientId: connectClient.id,
      });
      client = { ...connectClient, revision };
    }

    return { setup, client, limit };
  }
);
