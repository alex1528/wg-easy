import {
  defineEventHandler,
  getHeader,
  setHeader,
  setResponseStatus,
} from 'h3';
import type { H3Event } from 'h3';
import { sha256 } from 'js-sha256';

import Database from '#server/utils/Database';
import WireGuard from '#server/utils/WireGuard';
import { computeETag, etagMatches } from '#server/utils/etag';
import {
  verifyLiveWireGuardToken,
  type TokenIdentity,
} from '#server/utils/liveWireGuardOidc';
import { getEffectiveOidcConfig } from '#server/utils/oidcRuntime';
import { createRateLimiter } from '#server/utils/rateLimit';
import { logSecurityEvent } from '#server/utils/securityLogger';
import { getTrustedRequestIP } from '#server/utils/trustedProxy';
import {
  isValidDeviceId,
  isValidPublicKey,
} from '#server/utils/livewireGuardValidation';
import { WG_ENV } from '#server/utils/config';
import {
  ClientLimitReachedError,
  clientLimitFor,
} from '#server/utils/clientLimit';
import { MaxClientsReachedError } from '#db/repositories/client/service';

// 60 requests per minute per IP
const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

function uniqueStrings(values: (string | null | undefined)[]) {
  return [
    ...new Set(
      values.filter((v): v is string => typeof v === 'string' && v !== '')
    ),
  ];
}

function respondError(
  event: H3Event,
  statusCode: number,
  error: string,
  error_description: string
) {
  setResponseStatus(event, statusCode);
  return { error, error_description };
}

/**
 * LiveWireGuard provisioning endpoint.
 *
 * See docs/LiveWireGuard-server-integration.md for the interface contract.
 * Auth is done by validating the OIDC tokens sent by the client, not by
 * session or API token.
 */
export default defineEventHandler(async (event) => {
  // 1) rate limit
  const requestIp =
    getTrustedRequestIP(event, WG_ENV.TRUSTED_PROXIES) ?? 'unknown';
  const rate = rateLimiter.check(requestIp);
  if (!rate.allowed) {
    // h3 types the Retry-After value as number
    setHeader(event, 'Retry-After', rate.retryAfterSeconds);
    return respondError(event, 429, 'rate_limited', 'Too many requests');
  }

  // 2) feature switch (404 = transient for the client, not a revocation)
  const lwConfig = await Database.general.getLiveWireGuardConfig();
  const oidc = await getEffectiveOidcConfig();
  if (!lwConfig.enabled || !oidc.server || !oidc.clientId) {
    return respondError(event, 404, 'not_found', 'Endpoint not available');
  }

  // 3) headers
  const authorization = getHeader(event, 'authorization');
  const idToken = getHeader(event, 'x-id-token');
  const deviceId = getHeader(event, 'x-device-id');
  const publicKey = getHeader(event, 'x-public-key');

  if (!authorization || !deviceId || !publicKey) {
    return respondError(event, 400, 'invalid_request', 'Missing headers');
  }

  const [authMethod, accessToken] = authorization.split(' ');
  if (authMethod !== 'Bearer' || !accessToken) {
    logSecurityEvent(event, 'livewireguard', deviceId.slice(0, 8));
    return respondError(event, 401, 'invalid_token', 'Bearer token required');
  }

  if (!isValidDeviceId(deviceId)) {
    return respondError(event, 400, 'invalid_request', 'Invalid device id');
  }

  if (!isValidPublicKey(publicKey)) {
    return respondError(event, 400, 'invalid_request', 'Invalid public key');
  }

  // 4) token validation
  const verifyResult = await verifyLiveWireGuardToken({
    accessToken,
    idToken,
    audiences: uniqueStrings([
      lwConfig.audience,
      oidc.clientId,
      oidc.app.clientId,
    ]),
    idTokenAudiences: uniqueStrings([oidc.clientId, oidc.app.clientId]),
  });

  if (!verifyResult.ok) {
    if (verifyResult.reason === 'server_misconfigured') {
      return respondError(
        event,
        500,
        'server_error',
        'OIDC provider misconfigured'
      );
    }
    logSecurityEvent(event, 'livewireguard', deviceId.slice(0, 8));
    return respondError(event, 401, 'invalid_token', 'Token validation failed');
  }

  const identity: TokenIdentity = verifyResult.identity;

  // 5) user mapping
  const user = await Database.users.findOidcUser(
    identity.sub,
    identity.email,
    identity.emailVerified
  );

  if (!user) {
    return respondError(
      event,
      403,
      'forbidden',
      'No linked wg-easy account for this identity'
    );
  }

  if (!user.enabled) {
    return respondError(event, 403, 'forbidden', 'Account disabled');
  }

  // 6) device -> client mapping
  let clientRecord = await Database.clients.getByDevice(user.id, deviceId);

  if (clientRecord && clientRecord.publicKey !== publicKey) {
    // device regenerated its key pair
    const rotated = await Database.clients.rotatePublicKey(
      clientRecord.id,
      publicKey
    );
    if (rotated === 'conflict') {
      return respondError(
        event,
        500,
        'server_error',
        'Public key conflict, please retry'
      );
    }
    await WireGuard.saveConfig();
  }

  if (!clientRecord) {
    // same key, different device id (re-login): claim the existing client
    clientRecord = await Database.clients.getByPublicKeyForUser(
      user.id,
      publicKey
    );
    if (clientRecord) {
      await Database.clients.setDeviceId(clientRecord.id, deviceId);
    }
  }

  if (!clientRecord) {
    try {
      const created = await Database.clients.createForDevice({
        // new devices count against "Max Clients per User"
        limit: clientLimitFor(
          user,
          await Database.general.getMaxClientsPerUser()
        ),
        userId: user.id,
        deviceId,
        publicKey,
        name: `LiveWireGuard-${deviceId.slice(0, 8)}`,
      });
      clientRecord = await Database.clients.get(created.clientId);
      if (!clientRecord) {
        throw new Error('Client not found after creation');
      }
      await WireGuard.saveConfig();
    } catch (err) {
      if (err instanceof ClientLimitReachedError) {
        // same code as the address pool: the app retries with backoff
        return respondError(
          event,
          409,
          'device_limit_reached',
          `Client limit reached (${err.count}/${err.limit}), delete an old client in the panel`
        );
      }
      if (err instanceof MaxClientsReachedError) {
        return respondError(
          event,
          409,
          'device_limit_reached',
          'No addresses available, maximum number of clients reached'
        );
      }
      throw err;
    }
  }

  if (!clientRecord.enabled) {
    return respondError(event, 410, 'forbidden', 'Device has been revoked');
  }

  // 7) build response (fixed key order for a deterministic body)
  const wgQuick = await WireGuard.getClientConfigurationKeyless({
    clientId: clientRecord.id,
  });

  const body = JSON.stringify({
    configs: [
      {
        remote_id: deviceId,
        name: clientRecord.name,
        wg_quick: wgQuick,
        revision: sha256(wgQuick).slice(0, 12),
        ...(clientRecord.expiresAt
          ? { expires_at: clientRecord.expiresAt }
          : {}),
      },
    ],
    policy: {
      allow_export: false,
      offline_grace_seconds: 0,
    },
  });

  // 8) etag / 304
  const etag = computeETag(body);
  if (etagMatches(getHeader(event, 'if-none-match'), etag)) {
    setResponseStatus(event, 304);
    setHeader(event, 'ETag', etag);
    return null;
  }

  setHeader(event, 'ETag', etag);
  setHeader(event, 'Cache-Control', 'no-store');
  setHeader(event, 'Content-Type', 'application/json');
  setResponseStatus(event, 200);
  return body;
});
