/**
 * Runtime OIDC configuration: DB overrides (admin panel) with env fallback.
 * Read on every call so changes take effect without a restart.
 *
 * ! oauth.ts must import this file dynamically (config.ts <-> oauth.ts cycle)
 */
import Database from '#server/utils/Database';
import {
  resolveOidcConfig,
  type EffectiveOidcConfig,
  type OidcEnv,
} from '#server/utils/oidcSettings';

/** OIDC values from the environment (read raw, not filtered by WG_ENV) */
export function getOidcEnv(): OidcEnv {
  const providers =
    process.env.OAUTH_PROVIDERS?.split(',').map((v) => v.trim()) ?? [];
  return {
    enabled: providers.includes('oidc'),
    friendlyName: process.env.OAUTH_OIDC_NAME,
    server: process.env.OAUTH_OIDC_SERVER,
    clientId: process.env.OAUTH_OIDC_CLIENT_ID,
    clientSecret: process.env.OAUTH_OIDC_CLIENT_SECRET,
  };
}

export async function getEffectiveOidcConfig(): Promise<EffectiveOidcConfig> {
  const row = await Database.oidcSettings.get();
  return resolveOidcConfig(getOidcEnv(), row);
}

/** OAUTH_AUTO_LAUNCH=oidc only applies while OIDC is usable */
export function isOidcAutoLaunch(config: EffectiveOidcConfig) {
  return process.env.OAUTH_AUTO_LAUNCH === 'oidc' && config.isConfigured;
}
