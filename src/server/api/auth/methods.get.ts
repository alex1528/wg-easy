import { defineEventHandler } from 'h3';

import { WG_ENV } from '#server/utils/config';
import { OAUTH_PROVIDERS } from '#server/utils/oauth';
import type { OAUTH_PROVIDER } from '#server/utils/oauth';
import {
  getEffectiveOidcConfig,
  isOidcAutoLaunch,
} from '#server/utils/oidcRuntime';

export default defineEventHandler(async () => {
  const oidc = await getEffectiveOidcConfig();

  const providers = {} as Record<
    OAUTH_PROVIDER,
    { enabled: true; friendlyName: string }
  >;

  // google / github: static env config
  for (const provider of WG_ENV.OAUTH_PROVIDERS ?? []) {
    if (provider === 'oidc') continue;
    providers[provider] = {
      enabled: true,
      friendlyName: OAUTH_PROVIDERS[provider].friendlyName,
    };
  }

  // oidc: DB overrides with env fallback
  if (oidc.isConfigured) {
    providers.oidc = { enabled: true, friendlyName: oidc.friendlyName };
  }

  let autoLaunchProvider: OAUTH_PROVIDER | null =
    WG_ENV.OAUTH_AUTO_LAUNCH === 'oidc' ? null : WG_ENV.OAUTH_AUTO_LAUNCH;
  if (isOidcAutoLaunch(oidc)) {
    autoLaunchProvider = 'oidc';
  }

  const oauthEnabled = Object.keys(providers).length > 0;

  return {
    providers: oauthEnabled ? providers : undefined,
    oauthEnabled,
    passwordDisabled: WG_ENV.DISABLE_PASSWORD_AUTH,
    autoLaunchProvider,
  };
});
