/**
 * Pure helpers for the OIDC configuration: merge DB overrides with the
 * environment and build the LiveWireGuard setup QR payload.
 *
 * ! Keep this file free of imports from config.ts / oauth.ts / Database.ts
 * so it can be unit tested and used without import cycles.
 */
import { sha256 } from 'js-sha256';

export const DEFAULT_OIDC_NAME = 'OIDC';
export const DEFAULT_APP_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
];
export const DEFAULT_APP_REDIRECT_URI =
  'com.wuxichaorongtechnologycoltd.livewireguard:/oidc/callback';
export const DEFAULT_GROUPS_CLAIM = 'groups';
export const DEFAULT_PANEL_SCOPES = ['openid', 'email', 'profile'];
export const SETUP_PAYLOAD_TYPE = 'livewireguard-setup';
export const SETUP_PAYLOAD_VERSION = 1;

export type OidcEnv = {
  /** OIDC is listed in OAUTH_PROVIDERS */
  enabled: boolean;
  friendlyName?: string;
  server?: string;
  clientId?: string;
  clientSecret?: string;
};

export type OidcDbRow = {
  enabled: boolean | null;
  friendlyName: string | null;
  server: string | null;
  clientId: string | null;
  clientSecret: string | null;
  appClientId: string | null;
  appClientSecret: string | null;
  appScopes: string | null;
  appRedirectUri: string | null;
  endpointUrl: string | null;
};

export type ValueSource = 'db' | 'env' | 'default' | 'none';

export type EffectiveOidcConfig = {
  enabled: boolean;
  friendlyName: string;
  server: string | null;
  clientId: string | null;
  clientSecret: string | null;
  /** enabled and server / client id / client secret set */
  isConfigured: boolean;
  app: {
    clientId: string | null;
    clientSecret: string | null;
    scopes: string[];
    redirectUri: string;
    /** null = derive from the request host */
    endpointUrl: string | null;
  };
  sources: {
    enabled: ValueSource;
    friendlyName: ValueSource;
    server: ValueSource;
    clientId: ValueSource;
    clientSecret: ValueSource;
    appClientId: ValueSource;
    appClientSecret: ValueSource;
    appScopes: ValueSource;
    appRedirectUri: ValueSource;
    endpointUrl: ValueSource;
  };
};

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

function pick(
  db: string | null | undefined,
  env: string | null | undefined
): [string | null, ValueSource] {
  const dbValue = nonEmpty(db);
  if (dbValue !== null) return [dbValue, 'db'];
  const envValue = nonEmpty(env);
  if (envValue !== null) return [envValue, 'env'];
  return [null, 'none'];
}

export function splitScopes(value: string) {
  return value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** trim, drop empty values and duplicates (keeps the first occurrence) */
export function normalizeList(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '' && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  }
  return result;
}

/** comma separated list, e.g. `OAUTH_OIDC_ADMIN_GROUPS=wg-admins,ops` */
export function splitList(value: string) {
  return normalizeList(value.split(','));
}

export type OidcRoleEnv = {
  /** comma separated (OAUTH_OIDC_ADMIN_GROUPS) */
  adminGroups?: string;
  /** OAUTH_OIDC_GROUPS_CLAIM */
  groupsClaim?: string;
  /** space or comma separated (OAUTH_OIDC_SCOPES) */
  panelScopes?: string;
};

export type OidcRoleDbRow = {
  adminGroups?: string[] | null;
  groupsClaim?: string | null;
  panelScopes?: string | null;
};

export type OidcRoleMapping = {
  /** empty = role mapping disabled */
  adminGroups: string[];
  groupsClaim: string;
  /** always contains openid */
  panelScopes: string[];
  sources: {
    adminGroups: ValueSource;
    groupsClaim: ValueSource;
    panelScopes: ValueSource;
  };
};

/**
 * Role mapping settings: DB overrides with env fallback, then defaults.
 */
export function resolveOidcRoleMapping(
  env: OidcRoleEnv,
  db: OidcRoleDbRow | null
): OidcRoleMapping {
  let adminGroups: string[] = [];
  let adminGroupsSource: ValueSource = 'none';
  const dbGroups = Array.isArray(db?.adminGroups)
    ? normalizeList(db.adminGroups)
    : [];
  if (dbGroups.length > 0) {
    adminGroups = dbGroups;
    adminGroupsSource = 'db';
  } else if (env.adminGroups) {
    const envGroups = splitList(env.adminGroups);
    if (envGroups.length > 0) {
      adminGroups = envGroups;
      adminGroupsSource = 'env';
    }
  }

  const [claim, claimSource] = pick(db?.groupsClaim, env.groupsClaim);

  const [scopesValue, scopesSource] = pick(db?.panelScopes, env.panelScopes);
  let panelScopes = scopesValue
    ? normalizeList(splitScopes(scopesValue))
    : [...DEFAULT_PANEL_SCOPES];
  if (!panelScopes.includes('openid')) {
    panelScopes = ['openid', ...panelScopes];
  }

  return {
    adminGroups,
    groupsClaim: claim ?? DEFAULT_GROUPS_CLAIM,
    panelScopes,
    sources: {
      adminGroups: adminGroupsSource,
      groupsClaim: claim === null ? 'default' : claimSource,
      panelScopes: scopesValue === null ? 'default' : scopesSource,
    },
  };
}

/**
 * Merge the DB override row with the environment.
 * Every field falls back individually: null / empty in the DB = use env.
 */
export function resolveOidcConfig(
  env: OidcEnv,
  db: OidcDbRow | null
): EffectiveOidcConfig {
  const enabled = db?.enabled ?? env.enabled;
  const enabledSource: ValueSource =
    db?.enabled === null || db?.enabled === undefined ? 'env' : 'db';

  const [friendlyNameValue, friendlyNameSource] = pick(
    db?.friendlyName,
    env.friendlyName
  );
  const [server, serverSource] = pick(db?.server, env.server);
  const [clientId, clientIdSource] = pick(db?.clientId, env.clientId);
  const [clientSecret, clientSecretSource] = pick(
    db?.clientSecret,
    env.clientSecret
  );

  // app client: own client id (with its own secret) or the panel's client
  const appClientIdDb = nonEmpty(db?.appClientId);
  let appClientId: string | null;
  let appClientSecret: string | null;
  let appClientIdSource: ValueSource;
  let appClientSecretSource: ValueSource;
  if (appClientIdDb !== null) {
    appClientId = appClientIdDb;
    appClientIdSource = 'db';
    appClientSecret = nonEmpty(db?.appClientSecret);
    appClientSecretSource = appClientSecret === null ? 'none' : 'db';
  } else {
    appClientId = clientId;
    appClientIdSource = clientIdSource;
    appClientSecret = clientSecret;
    appClientSecretSource = clientSecretSource;
  }

  const scopesDb = nonEmpty(db?.appScopes);
  const scopes = scopesDb ? splitScopes(scopesDb) : [...DEFAULT_APP_SCOPES];

  const redirectDb = nonEmpty(db?.appRedirectUri);
  const endpointDb = nonEmpty(db?.endpointUrl);

  return {
    enabled,
    friendlyName: friendlyNameValue ?? DEFAULT_OIDC_NAME,
    server,
    clientId,
    clientSecret,
    isConfigured:
      enabled && server !== null && clientId !== null && clientSecret !== null,
    app: {
      clientId: appClientId,
      clientSecret: appClientSecret,
      scopes,
      redirectUri: redirectDb ?? DEFAULT_APP_REDIRECT_URI,
      endpointUrl: endpointDb,
    },
    sources: {
      enabled: enabledSource,
      friendlyName: friendlyNameValue === null ? 'default' : friendlyNameSource,
      server: serverSource,
      clientId: clientIdSource,
      clientSecret: clientSecretSource,
      appClientId: appClientIdSource,
      appClientSecret: appClientSecretSource,
      appScopes: scopesDb ? 'db' : 'default',
      appRedirectUri: redirectDb ? 'db' : 'default',
      endpointUrl: endpointDb ? 'db' : 'default',
    },
  };
}

export type SetupPayload = {
  type: typeof SETUP_PAYLOAD_TYPE;
  v: typeof SETUP_PAYLOAD_VERSION;
  name?: string;
  issuer?: string;
  client_id?: string;
  client_secret?: string;
  scopes?: string[];
  redirect_uri?: string;
  endpoint?: string;
};

/**
 * Build the v1 setup payload scanned by the LiveWireGuard app.
 * Fields without a value are omitted; the key order is fixed.
 */
export function buildSetupPayload(
  config: EffectiveOidcConfig,
  opts: { endpointUrl: string; issuer?: string | null }
): SetupPayload {
  const payload: SetupPayload = {
    type: SETUP_PAYLOAD_TYPE,
    v: SETUP_PAYLOAD_VERSION,
  };
  const name = nonEmpty(config.friendlyName);
  if (name) payload.name = name;
  const issuer = nonEmpty(opts.issuer) ?? config.server;
  if (issuer) payload.issuer = issuer;
  if (config.app.clientId) payload.client_id = config.app.clientId;
  if (config.app.clientSecret) payload.client_secret = config.app.clientSecret;
  if (config.app.scopes.length > 0) payload.scopes = [...config.app.scopes];
  if (config.app.redirectUri) payload.redirect_uri = config.app.redirectUri;
  const endpoint =
    nonEmpty(config.app.endpointUrl) ?? nonEmpty(opts.endpointUrl);
  if (endpoint) payload.endpoint = endpoint;
  return payload;
}

export function serializeSetupPayload(payload: SetupPayload) {
  return JSON.stringify(payload);
}

export const SETUP_LINK_PREFIX = 'livewireguard://setup?d=';

/**
 * The string encoded in the setup QR code:
 * `livewireguard://setup?d=<base64url(UTF-8 JSON)>`.
 *
 * Base64url is an encoding, not encryption: it only keeps the content from
 * being readable at a glance. The same link works for the QR code, an
 * "Open in LiveWireGuard" button and the iOS system camera.
 */
export function buildSetupLink(payload: SetupPayload) {
  const encoded = Buffer.from(serializeSetupPayload(payload), 'utf8').toString(
    'base64url'
  );
  return `${SETUP_LINK_PREFIX}${encoded}`;
}

/** short, stable hash used to detect changes on the client side */
export function revisionOf(text: string) {
  return sha256(text).slice(0, 12);
}
