import Database from '#server/utils/Database';
import { definePermissionEventHandler } from '#server/utils/handler';
import { matchAdminGroups } from '#server/utils/oidcRole';
import { getOidcEnv, getOidcRoleEnv } from '#server/utils/oidcRuntime';
import {
  DEFAULT_APP_REDIRECT_URI,
  DEFAULT_APP_SCOPES,
  DEFAULT_GROUPS_CLAIM,
  DEFAULT_OIDC_NAME,
  DEFAULT_PANEL_SCOPES,
  resolveOidcConfig,
  resolveOidcRoleMapping,
  splitList,
} from '#server/utils/oidcSettings';
import { getDefaultEndpointUrl } from '#server/utils/oidcSetup';

/**
 * OIDC settings for the admin panel.
 * Secrets are never returned, only whether they are set.
 */
export default definePermissionEventHandler(
  'admin',
  'any',
  async ({ event, user }) => {
    const env = getOidcEnv();
    const roleEnv = getOidcRoleEnv();
    const row = await Database.oidcSettings.get();
    const effective = resolveOidcConfig(env, row);
    const roleMapping = resolveOidcRoleMapping(roleEnv, row);

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
        adminGroups: row?.adminGroups ?? null,
        groupsClaim: row?.groupsClaim ?? null,
        panelScopes: row?.panelScopes ?? null,
      },
      env: {
        enabled: env.enabled,
        friendlyName: env.friendlyName || null,
        server: env.server || null,
        clientId: env.clientId || null,
        hasClientSecret: !!env.clientSecret,
        adminGroups: roleEnv.adminGroups
          ? splitList(roleEnv.adminGroups)
          : null,
        groupsClaim: roleEnv.groupsClaim || null,
        panelScopes: roleEnv.panelScopes || null,
      },
      defaults: {
        friendlyName: DEFAULT_OIDC_NAME,
        appScopes: DEFAULT_APP_SCOPES.join(' '),
        appRedirectUri: DEFAULT_APP_REDIRECT_URI,
        endpointUrl: getDefaultEndpointUrl(event),
        groupsClaim: DEFAULT_GROUPS_CLAIM,
        panelScopes: DEFAULT_PANEL_SCOPES.join(' '),
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
        adminGroups: roleMapping.adminGroups,
        groupsClaim: roleMapping.groupsClaim,
        panelScopes: roleMapping.panelScopes.join(' '),
      },
      sources: { ...effective.sources, ...roleMapping.sources },
      /** groups received on the last OIDC login of the current admin */
      self:
        user.oauthProvider === 'oidc'
          ? {
              groups: user.oidcGroups,
              matched: user.oidcGroups
                ? matchAdminGroups(user.oidcGroups, roleMapping.adminGroups)
                : [],
              roleSource: user.roleSource,
              lastLoginAt: user.lastLoginAt,
            }
          : null,
    };
  }
);
