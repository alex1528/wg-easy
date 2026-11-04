import Database from '#server/utils/Database';
import { definePermissionEventHandler } from '#server/utils/handler';
import { getOidcEnv } from '#server/utils/oidcRuntime';
import {
  DEFAULT_APP_REDIRECT_URI,
  DEFAULT_APP_SCOPES,
  DEFAULT_OIDC_NAME,
  resolveOidcConfig,
} from '#server/utils/oidcSettings';
import { getDefaultEndpointUrl } from '#server/utils/oidcSetup';

/**
 * OIDC settings for the admin panel.
 * Secrets are never returned, only whether they are set.
 */
export default definePermissionEventHandler(
  'admin',
  'any',
  async ({ event }) => {
    const env = getOidcEnv();
    const row = await Database.oidcSettings.get();
    const effective = resolveOidcConfig(env, row);

    return {
      db: {
        enabled: row?.enabled ?? null,
        friendlyName: row?.friendlyName ?? null,
        server: row?.server ?? null,
        clientId: row?.clientId ?? null,
        hasClientSecret: !!row?.clientSecret,
        appClientId: row?.appClientId ?? null,
        hasAppClientSecret: !!row?.appClientSecret,
        appScopes: row?.appScopes ?? null,
        appRedirectUri: row?.appRedirectUri ?? null,
        endpointUrl: row?.endpointUrl ?? null,
      },
      env: {
        enabled: env.enabled,
        friendlyName: env.friendlyName || null,
        server: env.server || null,
        clientId: env.clientId || null,
        hasClientSecret: !!env.clientSecret,
      },
      defaults: {
        friendlyName: DEFAULT_OIDC_NAME,
        appScopes: DEFAULT_APP_SCOPES.join(' '),
        appRedirectUri: DEFAULT_APP_REDIRECT_URI,
        endpointUrl: getDefaultEndpointUrl(event),
      },
      effective: {
        enabled: effective.enabled,
        isConfigured: effective.isConfigured,
        friendlyName: effective.friendlyName,
        server: effective.server,
        clientId: effective.clientId,
        hasClientSecret: effective.clientSecret !== null,
        appClientId: effective.app.clientId,
        hasAppClientSecret: effective.app.clientSecret !== null,
        appScopes: effective.app.scopes.join(' '),
        appRedirectUri: effective.app.redirectUri,
        endpointUrl: effective.app.endpointUrl ?? getDefaultEndpointUrl(event),
      },
      sources: effective.sources,
    };
  }
);
