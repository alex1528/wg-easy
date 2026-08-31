import { createError, defineEventHandler } from 'h3';

import Database from '#server/utils/Database';
import WireGuard from '#server/utils/WireGuard';
import { getCurrentUser } from '#server/utils/session';

/**
 * POST /api/client/provision
 *
 * Self-service endpoint: find or create a WireGuard client for the
 * currently authenticated user. Idempotent — calling multiple times
 * returns the same client.
 *
 * Authentication: Bearer token (OIDC access_token) or session cookie.
 * Authorization: any authenticated & enabled user (bypasses permission matrix).
 *
 * Response: { clientId, name, configuration, created }
 */
export default defineEventHandler(async (event) => {
  // 1. Authenticate (reuses Bearer token → Authentik userinfo → auto-register)
  const user = await getCurrentUser(event);

  // 2. Find existing clients for this user
  const existingClients = await Database.clients.getAllForUser(user.id, {});

  let targetClientId: number;
  let created = false;

  if (existingClients.length > 0) {
    // Prefer first enabled client, fallback to first available
    const enabled = existingClients.find((c) => c.enabled);
    targetClientId = (enabled || existingClients[0]!).id;
  } else {
    // 3. Create new client bound to this user
    const name = deriveClientName(user);
    const result = await Database.clients.createForUser({
      name,
      userId: user.id,
      expiresAt: null,
    });

    targetClientId = result[0]!.clientId;
    created = true;

    // 4. Save WireGuard config and sync
    await WireGuard.saveConfig();
  }

  // 5. Generate .conf content
  const configuration = await WireGuard.getClientConfiguration({
    clientId: targetClientId,
  });

  const client = await Database.clients.get(targetClientId);
  if (!client) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to retrieve client after creation',
    });
  }

  return {
    clientId: targetClientId,
    name: client.name,
    configuration,
    created,
  };
});

/**
 * Derive a unique client name from user info.
 * Format: "{base}_{4-char random}" to avoid collisions.
 */
function deriveClientName(user: {
  name: string | null;
  email: string | null;
  username: string;
}): string {
  let base = '';

  if (user.name) {
    base = user.name;
  } else if (user.email) {
    const atIdx = user.email.indexOf('@');
    base = atIdx > 0 ? user.email.substring(0, atIdx) : user.email;
  }

  if (!base) {
    base = user.username;
  }

  // Sanitize: keep only alphanumeric, underscore, dot, hyphen
  base = base
    .replace(/[^a-zA-Z0-9_.\-]/g, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 24);

  // Append 4-char random suffix for uniqueness
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${base}_${suffix}`;
}
