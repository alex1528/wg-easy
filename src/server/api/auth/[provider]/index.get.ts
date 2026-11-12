import {
  defineEventHandler,
  getQuery,
  getValidatedQuery,
  sendRedirect,
} from 'h3';
import type { H3Event } from 'h3';
import * as client from 'openid-client';
import { z } from 'zod';

import { WG_ENV } from '#server/utils/config';
import { oauthErrorRedirect } from '#server/utils/i18nError';
import { buildOauthConfig } from '#server/utils/oauth';
import { useWGSession } from '#server/utils/session';
import { getTrustedRequestHost } from '#server/utils/trustedProxy';
import { validateZod } from '#server/utils/types';

const OauthQuerySchema = z.object({
  link: z.coerce.boolean().optional(),
});

async function startLogin(event: H3Event) {
  const params = await getValidatedQuery(
    event,
    validateZod(OauthQuerySchema, event)
  );

  const { config, provider, providerConfig } = await buildOauthConfig(event);

  const host = getTrustedRequestHost(event, WG_ENV.TRUSTED_PROXIES);
  const protocol = WG_ENV.INSECURE ? 'http' : 'https';
  const baseUri = `${protocol}://${host}/api/auth/${provider}`;

  let redirectUri = `${baseUri}/callback`;
  if (params.link) {
    redirectUri = `${baseUri}/link`;
  }

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const nonce = client.randomNonce();
  const state = client.randomState();

  const parameters: Record<string, string> = {
    ...providerConfig.params,
    redirect_uri: redirectUri,
    scope: providerConfig.scope,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    nonce: nonce,
    state: state,
  };

  const session = await useWGSession(event);
  await session.update({
    oauth_nonce: nonce,
    oauth_verifier: codeVerifier,
    oauth_state: state,
  });

  const redirectTo = client.buildAuthorizationUrl(config, parameters);

  return sendRedirect(event, redirectTo.toString());
}

/** errors are shown on the login / account page (no JSON error page) */
export default defineEventHandler(async (event) => {
  try {
    return await startLogin(event);
  } catch (err) {
    const link = getQuery(event).link;
    return oauthErrorRedirect(event, err, link ? '/me' : '/login');
  }
});
