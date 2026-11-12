/**
 * Per user client limit (Admin Panel -> General -> Max Clients per User).
 *
 * The limit applies to clients a non admin user creates themselves
 * (self service QR code, LiveWireGuard devices). Admins are not limited,
 * neither are clients an admin creates for a user in the panel.
 * Every client of the user counts, including disabled ones.
 */
import { roles, type Role } from '#shared/utils/permissions';

export const DEFAULT_MAX_CLIENTS_PER_USER = 5;

export class ClientLimitReachedError extends Error {
  readonly limit: number;
  readonly count: number;

  constructor(limit: number, count: number) {
    super(`Client limit reached (${count}/${limit})`);
    this.limit = limit;
    this.count = count;
  }
}

/**
 * @param maxClientsPerUser setting, 0 = unlimited
 * @returns the limit for this user, null = unlimited
 */
export function clientLimitFor(
  user: { role: Role },
  maxClientsPerUser: number
): number | null {
  if (user.role === roles.ADMIN) return null;
  if (!Number.isInteger(maxClientsPerUser) || maxClientsPerUser <= 0) {
    return null;
  }
  return maxClientsPerUser;
}

export function isClientLimitReached(count: number, limit: number | null) {
  return limit !== null && count >= limit;
}

/** for the UI, null = unlimited */
export function clientUsage(count: number, limit: number | null) {
  if (limit === null) return null;
  return { used: count, max: limit, reached: count >= limit };
}
