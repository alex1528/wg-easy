import { createError, readValidatedBody } from 'h3';

import Database from '#server/utils/Database';
import { WG_ENV } from '#server/utils/config';
import { definePermissionEventHandler } from '#server/utils/handler';
import { invalidateOidcCache } from '#server/utils/liveWireGuardOidc';
import { getOidcEnv } from '#server/utils/oidcRuntime';
import { resolveOidcConfig } from '#server/utils/oidcSettings';
import { validateZod } from '#server/utils/types';
import { OidcSettingsUpdateSchema } from '#db/repositories/oidcSettings/types';

export default definePermissionEventHandler(
  'admin',
  'any',
  async ({ event }) => {
    const data = await readValidatedBody(
      event,
      validateZod(OidcSettingsUpdateSchema, event)
    );

    // don't lock everybody out: with password login disabled, OIDC must stay
    // usable unless another OAuth provider is available
    if (WG_ENV.DISABLE_PASSWORD_AUTH) {
      const current = await Database.oidcSettings.get();
      const next = resolveOidcConfig(getOidcEnv(), {
        enabled: data.enabled,
        friendlyName: data.friendlyName,
        server: data.server,
        clientId: data.clientId,
        clientSecret:
          data.clientSecret === undefined
            ? (current?.clientSecret ?? null)
            : data.clientSecret,
        appClientId: data.appClientId,
        appClientSecret:
          data.appClientSecret === undefined
            ? (current?.appClientSecret ?? null)
            : data.appClientSecret,
        appScopes: data.appScopes,
        appRedirectUri: data.appRedirectUri,
        endpointUrl: data.endpointUrl,
      });
      const otherProviders = (WG_ENV.OAUTH_PROVIDERS ?? []).filter(
        (p) => p !== 'oidc'
      );
      if (!next.isConfigured && otherProviders.length === 0) {
        throw createError({
          statusCode: 400,
          statusMessage:
            'Password login is disabled: OIDC must stay enabled and configured',
        });
      }
    }

    await Database.oidcSettings.update(data);
    invalidateOidcCache();
    return { success: true };
  }
);
