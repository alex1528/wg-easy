import { createError, getHeader, getSession, useSession } from 'h3';
import type { H3Event } from 'h3';

import { OAUTH_PROVIDERS } from '#server/utils/oauth';
import Database from '#server/utils/Database';
import { WG_ENV } from '#server/utils/config';
import { isPasswordValid } from '#server/utils/password';
import type { ID } from '#server/utils/types';
import type { UserType } from '#db/repositories/user/types';

export type WGSession = Partial<{
  userId: ID;
  pendingLogin: {
    type: 'password' | 'oauth';
    userId: ID;
    remember: boolean;
    /** in milliseconds */
    expires_at: number;
  };
  oauth_verifier: string;
  oauth_nonce: string;
  oauth_state: string;
}>;

const name = 'wg-easy';

export async function useWGSession(event: H3Event, rememberMe = false) {
  const sessionConfig = await Database.general.getSessionConfig();
  return useSession<WGSession>(event, {
    password: sessionConfig.sessionPassword,
    name,
    // TODO: add session expiration
    // maxAge: undefined
    cookie: {
      maxAge: rememberMe ? sessionConfig.sessionTimeout : undefined,
      secure: !WG_ENV.INSECURE,
    },
  });
}

export async function getWGSession(event: H3Event) {
  const sessionConfig = await Database.general.getSessionConfig();
  return getSession<WGSession>(event, {
    password: sessionConfig.sessionPassword,
    name,
    cookie: {
      secure: !WG_ENV.INSECURE,
    },
  });
}

/**
 * @throws
 */
export async function getCurrentUser(event: H3Event) {
  const session = await getWGSession(event);

  const authorization = getHeader(event, 'Authorization');

  let user: UserType | undefined;
  if (session.data.userId) {
    // Handle if authenticating using Session
    user = await Database.users.get(session.data.userId);
  } else if (authorization) {
    // Handle if authenticating using Header
    const [method, value] = authorization.split(' ');

    if (method === 'Bearer' && value) {
      // Handle Bearer Token authentication (OIDC access_token)
      user = await authenticateWithBearerToken(value);
    } else if (method === 'Basic' && value) {
      // Handle Basic Authentication
      if (WG_ENV.DISABLE_PASSWORD_AUTH) {
        throw createError({
          statusCode: 403,
          statusMessage: 'Password authentication is disabled',
        });
      }
      user = await authenticateWithBasicAuth(value);
    } else {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid Authorization method',
      });
    }
  } else {
    throw createError({
      statusCode: 401,
      statusMessage: 'Session failed. No Authorization',
    });
  }

  if (!user) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Session failed. User not found',
    });
  }

  if (!user.enabled) {
    throw createError({
      statusCode: 403,
      statusMessage: 'User is disabled',
    });
  }

  return user;
}

/**
 * Authenticate using OIDC Bearer Token.
 * Validates the token against the configured OIDC provider's userinfo endpoint.
 */
async function authenticateWithBearerToken(
  token: string
): Promise<UserType | undefined> {
  // Determine the userinfo endpoint from configured OIDC provider
  const oidcServer = process.env.OAUTH_OIDC_SERVER;
  if (!oidcServer) {
    throw createError({
      statusCode: 500,
      statusMessage: 'OIDC server not configured for Bearer token auth',
    });
  }

  // Call the OIDC provider's userinfo endpoint to validate the token
  let userInfo: { sub?: string; email?: string; email_verified?: boolean };
  try {
    // Derive userinfo URL from OIDC server base.
    // Authentik's userinfo is always at /application/o/userinfo/ regardless of provider slug.
    const baseUrl = new URL(oidcServer);
    const userinfoUrl = `${baseUrl.origin}/application/o/userinfo/`;

    const response = await fetch(userinfoUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Bearer token validation failed',
      });
    }

    userInfo = await response.json();
  } catch (e: any) {
    if (e.statusCode) throw e;
    throw createError({
      statusCode: 401,
      statusMessage: 'Bearer token validation failed',
    });
  }

  if (!userInfo.email) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Bearer token: no email in userinfo',
    });
  }

  // Check allowed domains
  if (WG_ENV.OAUTH_ALLOWED_DOMAINS) {
    const emailDomain = userInfo.email.slice(
      userInfo.email.lastIndexOf('@') + 1
    );
    if (!WG_ENV.OAUTH_ALLOWED_DOMAINS.includes(emailDomain)) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Email domain not allowed',
      });
    }
  }

  // Find user by email
  let user = await Database.users.getByEmail(userInfo.email);

  // Auto-register if enabled and user not found
  if (!user && WG_ENV.OAUTH_AUTO_REGISTER) {
    const result = await Database.users.loginWithOAuth(
      'oidc',
      userInfo.sub ?? userInfo.email,
      userInfo.email.split('@')[0],
      userInfo.email,
      userInfo.email.split('@')[0]
    );
    if (result.success) {
      user = result.user;
    }
  }

  return user;
}

/**
 * Authenticate using HTTP Basic Authentication.
 */
async function authenticateWithBasicAuth(
  value: string
): Promise<UserType | undefined> {
  const basicValue = Buffer.from(value, 'base64').toString('utf-8');

  // Split by first ":"
  const index = basicValue.indexOf(':');
  const username = basicValue.substring(0, index);
  const password = basicValue.substring(index + 1);

  if (!username || !password) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid Basic Authorization',
    });
  }

  const foundUser = await Database.users.getByUsername(username);

  // always check to avoid timing attack
  const userHashPassword = foundUser?.password ?? null;
  const passwordValid = await isPasswordValid(password, userHashPassword);

  // can't login through basic auth if 2fa enabled
  if (!foundUser || !passwordValid || foundUser.totpVerified) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Session failed',
    });
  }

  return foundUser;
}
