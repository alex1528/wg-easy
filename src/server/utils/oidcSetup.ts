import type { H3Event } from 'h3';

import Database from '#server/utils/Database';
import { WG_ENV } from '#server/utils/config';
import { getOidcIssuer } from '#server/utils/liveWireGuardOidc';
import { getEffectiveOidcConfig } from '#server/utils/oidcRuntime';
import {
  buildSetupLink,
  buildSetupPayload,
  revisionOf,
  type SetupPayload,
} from '#server/utils/oidcSettings';
import { getTrustedRequestHost } from '#server/utils/trustedProxy';

export type SetupInfo =
  | { configured: false; endpointEnabled: boolean }
  | {
      configured: true;
      endpointEnabled: boolean;
      payload: SetupPayload;
      /** the exact string encoded in the QR code: livewireguard://setup?d=<base64url JSON> */
      text: string;
      revision: string;
    };

/** default LiveWireGuard endpoint derived from the (trusted) request host */
export function getDefaultEndpointUrl(event: H3Event) {
  const host = getTrustedRequestHost(event, WG_ENV.TRUSTED_PROXIES);
  const protocol = WG_ENV.INSECURE ? 'http' : 'https';
  return `${protocol}://${host}/api/livewireguard/config`;
}

/**
 * Data for the LiveWireGuard setup QR code ("QR code A").
 * Contains every OIDC value the app needs, including the client secret.
 */
export async function getSetupInfo(event: H3Event): Promise<SetupInfo> {
  const [effective, lwConfig] = await Promise.all([
    getEffectiveOidcConfig(),
    Database.general.getLiveWireGuardConfig(),
  ]);

  const endpointEnabled = lwConfig.enabled;

  if (!effective.isConfigured) {
    return { configured: false, endpointEnabled };
  }

  const issuer = await getOidcIssuer();
  const payload = buildSetupPayload(effective, {
    endpointUrl: getDefaultEndpointUrl(event),
    issuer,
  });
  const text = buildSetupLink(payload);

  return {
    configured: true,
    endpointEnabled,
    payload,
    text,
    revision: revisionOf(text),
  };
}
