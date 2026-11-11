import { createError, defineEventHandler, sendRedirect } from 'h3';
import type { H3Event } from 'h3';

import Database from '#server/utils/Database';
import { SERVER_DEBUG } from '#server/utils/config';
import { oauthErrorRedirect } from '#server/utils/i18nError';
import { buildOauthConfig, getUserInfoWithClaims } from '#server/utils/oauth';
import { extractGroups, mergeClaims } from '#server/utils/oidcRole';
import { getEffectiveOidcRoleMapping } from '#server/utils/oidcRuntime';
import { useWGSession } from '#server/utils/session';
import { assertUnreachable } from '#server/utils/types';
import type { OidcRoleInput } from '#db/repositories/user/service';

async function handleCallback(event: H3Event) {
  const { config, provider, providerConfig } = await buildOauthConfig(event);

  const session = await useWGSession(event);
  if (
    !session.data.oauth_nonce ||
    !session.data.oauth_verifier ||
    !session.data.oauth_state
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing OAuth State',
    });
  }

  const { userInfo, idTokenClaims } = await getUserInfoWithClaims(
    event,
    config,
    {
      oauth_nonce: session.data.oauth_nonce,
      oauth_verifier: session.data.oauth_verifier,
      oauth_state: session.data.oauth_state,
    },
    providerConfig
  );

  // OIDC: map groups to the admin role
  let roleInput: OidcRoleInput | undefined;
  if (provider === 'oidc') {
    const roleMapping = await getEffectiveOidcRoleMapping();
    const groups = extractGroups(
      mergeClaims(idTokenClaims, userInfo),
      roleMapping.groupsClaim
    );
    roleInput = { groups, adminGroups: roleMapping.adminGroups };
  }

  const result = await Database.users.loginWithOAuth(
    provider,
    userInfo.sub,
    userInfo.preferred_username || userInfo.email,
    userInfo.email,
    userInfo.name || 'User',
    roleInput
  );

  if (!result.success) {
    switch (result.error) {
      case 'TOTP_REQUIRED':
        await session.update({
          pendingLogin: {
            type: 'oauth',
            userId: result.userId,
            remember: false,
            // 5min
            expires_at: Date.now() + 5 * 60 * 1000,
          },
          oauth_nonce: undefined,
          oauth_state: undefined,
          oauth_verifier: undefined,
        });
        return sendRedirect(event, '/login/2fa');
      case 'USER_DISABLED':
        throw createError({
          statusCode: 401,
          statusMessage: 'User disabled',
        });
      case 'USER_ALREADY_LINKED':
        throw createError({
          statusCode: 401,
          statusMessage:
            'User already linked with different account or provider',
        });
      case 'AUTO_REGISTER_DISABLED':
        throw createError({
          statusCode: 401,
          statusMessage: 'Auto registration is disabled',
        });
      case 'UNEXPECTED_ERROR':
        throw createError({
          statusCode: 500,
          statusMessage: 'Unexpected error',
        });
    }
    assertUnreachable(result);
  }

  // Create session
  const data = await session.update({
    userId: result.user.id,
    oauth_nonce: undefined,
    oauth_state: undefined,
    oauth_verifier: undefined,
  });

  await Database.users.recordLogin(result.user.id);

  SERVER_DEBUG(
    `New OAuth Session: ${data.id} for ${result.user.id} (${result.user.username}) with ${provider}`
  );

  return sendRedirect(event, '/');
}

/** errors are shown on the login page (no JSON error page) */
export default defineEventHandler(async (event) => {
  try {
    return await handleCallback(event);
  } catch (err) {
    return oauthErrorRedirect(event, err, '/login');
  }
});
