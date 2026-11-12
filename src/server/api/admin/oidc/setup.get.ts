import { setHeader } from 'h3';

import { definePermissionEventHandler } from '#server/utils/handler';
import { getSetupInfo } from '#server/utils/oidcSetup';

/** preview of the LiveWireGuard setup QR code for the admin panel */
export default definePermissionEventHandler(
  'admin',
  'any',
  async ({ event }) => {
    setHeader(event, 'Cache-Control', 'no-store');
    return getSetupInfo(event);
  }
);
