import * as client from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { getEffectiveOidcConfig } from '#server/utils/oidcRuntime';

export type TokenIdentity = {
  sub: string;
  email?: string;
  emailVerified?: boolean;
};

export type TokenVerifyResult =
  | { ok: true; identity: TokenIdentity }
  | { ok: false; reason: 'invalid_token' | 'server_misconfigured' };

type VerifyInput = {
  /** access_token from `Authorization: Bearer` (always present) */
  accessToken: string;
  /** id_token from `X-Id-Token` (optional) */
  idToken?: string;
  /** allowed audiences for a JWT access_token */
  audiences: string[];
  /** allowed audiences for the id_token (OIDC client ids) */
  idTokenAudiences: string[];
};

const DISCOVERY_CACHE_MS = 15 * 60 * 1000;
const CLOCK_TOLERANCE = '30s';

class MisconfiguredError extends Error {}

type CachedOidc = {
  config: client.Configuration;
  getJwks: ReturnType<typeof createRemoteJWKSet>;
  issuer: string;
};

/**
 * discovery + JWKS cache, keyed by the effective OIDC settings so that a
 * change in the admin panel is picked up immediately
 */
let oidcCache: {
  key: string;
  value: Promise<CachedOidc>;
  expiry: number;
} | null = null;

export function invalidateOidcCache() {
  oidcCache = null;
}

async function getOidc(): Promise<CachedOidc> {
  const effective = await getEffectiveOidcConfig();

  if (!effective.server || !effective.clientId) {
    throw new MisconfiguredError('OIDC provider is not configured');
  }

  const server = effective.server;
  const clientId = effective.clientId;
  const clientSecret = effective.clientSecret;
  const key = JSON.stringify([server, clientId, clientSecret]);
  const now = Date.now();

  if (oidcCache && oidcCache.key === key && oidcCache.expiry > now) {
    return oidcCache.value;
  }

  const value = (async () => {
    const config = await client.discovery(
      new URL(server),
      clientId,
      clientSecret ? { client_secret: clientSecret } : undefined
    );

    const metadata = config.serverMetadata();

    if (!metadata.jwks_uri) {
      throw new MisconfiguredError('OIDC discovery has no jwks_uri');
    }

    return {
      config,
      getJwks: createRemoteJWKSet(new URL(metadata.jwks_uri)),
      issuer: metadata.issuer,
    };
  })();

  const entry = { key, value, expiry: now + DISCOVERY_CACHE_MS };
  oidcCache = entry;
  try {
    return await value;
  } catch (err) {
    // don't cache failures
    if (oidcCache === entry) {
      oidcCache = null;
    }
    throw err;
  }
}

/**
 * issuer from OIDC discovery (null if discovery fails)
 */
export async function getOidcIssuer(): Promise<string | null> {
  try {
    const oidc = await getOidc();
    return oidc.issuer;
  } catch {
    return null;
  }
}

function isJwt(token: string): boolean {
  return token.split('.').length === 3;
}

function extractIdentity(payload: Record<string, unknown>): TokenIdentity {
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('Token has no subject');
  }

  const email =
    typeof payload.email === 'string' && payload.email.length > 0
      ? payload.email
      : undefined;

  const emailVerified =
    typeof payload.email_verified === 'boolean'
      ? payload.email_verified
      : undefined;

  return { sub, email, emailVerified };
}

/**
 * verify a JWT against the OIDC provider's JWKS.
 * `allowedAudiences`: the token is valid if its aud claim contains any of them.
 */
async function verifyJwt(
  token: string,
  allowedAudiences: string[]
): Promise<TokenIdentity> {
  const oidc = await getOidc();

  const { payload } = await jwtVerify(token, oidc.getJwks, {
    issuer: oidc.issuer,
    clockTolerance: CLOCK_TOLERANCE,
  });

  const aud = payload.aud;
  const audList = Array.isArray(aud) ? aud : aud !== undefined ? [aud] : [];
  const audienceValid =
    audList.length > 0 && audList.some((a) => allowedAudiences.includes(a));

  if (!audienceValid) {
    throw new Error('Token audience mismatch');
  }

  return extractIdentity(payload);
}

/**
 * Verify the tokens sent by a LiveWireGuard client and extract the user identity.
 *
 * The access_token can be a JWT or an opaque token; the id_token (optional) is
 * always a JWT. Validation order:
 * 1. JWT access_token (audience: LiveWireGuard audience or an OIDC client id)
 * 2. JWT id_token (audience: panel or app OIDC client id)
 * 3. userinfo endpoint (works for opaque access_tokens)
 */
export async function verifyLiveWireGuardToken(
  input: VerifyInput
): Promise<TokenVerifyResult> {
  let oidc: Awaited<ReturnType<typeof getOidc>>;
  try {
    oidc = await getOidc();
  } catch (err) {
    // discovery/JWKS problems are server-side, not the client's fault
    console.error('LiveWireGuard OIDC discovery failed:', err);
    return { ok: false, reason: 'server_misconfigured' };
  }

  try {
    if (isJwt(input.accessToken)) {
      // the access_token check is final: no fallback on failure
      const identity = await verifyJwt(input.accessToken, input.audiences);
      return { ok: true, identity };
    }

    if (input.idToken && isJwt(input.idToken)) {
      const identity = await verifyJwt(input.idToken, input.idTokenAudiences);
      return { ok: true, identity };
    }

    // opaque access_token without a usable id_token: validate via userinfo
    const userInfo = await client.fetchUserInfo(
      oidc.config,
      input.accessToken,
      client.skipSubjectCheck
    );

    if (!userInfo.sub) {
      return { ok: false, reason: 'invalid_token' };
    }

    return {
      ok: true,
      identity: {
        sub: userInfo.sub,
        email:
          typeof userInfo.email === 'string' && userInfo.email.length > 0
            ? userInfo.email
            : undefined,
        emailVerified:
          typeof userInfo.email_verified === 'boolean'
            ? userInfo.email_verified
            : undefined,
      },
    };
  } catch (err) {
    console.error('LiveWireGuard token verification failed:', err);
    return { ok: false, reason: 'invalid_token' };
  }
}
