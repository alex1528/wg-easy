/**
 * Pure helpers for the OIDC group -> role mapping.
 *
 * ! Keep this file free of imports from config.ts / oauth.ts / Database.ts
 * so it can be unit tested.
 */
import { roles, type Role, type RoleSource } from '#shared/utils/permissions';

/** at most this many groups are stored per user (matching uses all of them) */
export const MAX_STORED_GROUPS = 100;

type Claims = Record<string, unknown>;

function hasOwn(obj: object, key: string) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Read a claim: the exact key first (namespaced claims like
 * `https://example.com/groups`), then a dotted path (`realm_access.roles`).
 */
export function getClaim(claims: Claims, path: string): unknown {
  if (hasOwn(claims, path)) {
    return claims[path];
  }
  if (!path.includes('.')) {
    return undefined;
  }

  let current: unknown = claims;
  for (const part of path.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !hasOwn(current, part)
    ) {
      return undefined;
    }
    current = (current as Claims)[part];
  }
  return current;
}

/**
 * Groups of the user.
 * @returns `null` if the claim is missing or has an unusable type
 */
export function extractGroups(claims: Claims, path: string): string[] | null {
  const value = getClaim(claims, path);

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? [] : [trimmed];
  }

  if (Array.isArray(value)) {
    const result: string[] = [];
    for (const group of value) {
      if (typeof group !== 'string') continue;
      const trimmed = group.trim();
      if (trimmed !== '' && !result.includes(trimmed)) {
        result.push(trimmed);
      }
    }
    return result;
  }

  return null;
}

/** later sources win (pass id_token claims first, then userinfo) */
export function mergeClaims(...sources: (Claims | null | undefined)[]): Claims {
  const result: Claims = {};
  for (const source of sources) {
    if (source) {
      Object.assign(result, source);
    }
  }
  return result;
}

/** Keycloak sends full group paths (`/wg-admins`) */
function normalizeGroupName(group: string) {
  return group.trim().replace(/^\/+/, '');
}

/**
 * Admin groups the user is member of (case sensitive, leading `/` ignored)
 */
export function matchAdminGroups(
  groups: readonly string[],
  adminGroups: readonly string[]
): string[] {
  const wanted = new Set(
    adminGroups.map(normalizeGroupName).filter((g) => g !== '')
  );
  const matched: string[] = [];
  for (const group of groups) {
    if (wanted.has(normalizeGroupName(group)) && !matched.includes(group)) {
      matched.push(group);
    }
  }
  return matched;
}

export type DecideReason =
  | 'new_user_admin_group'
  | 'new_user_default'
  | 'groups_matched'
  | 'groups_not_matched'
  | 'manual'
  | 'no_admin_groups'
  | 'claim_missing';

export type RoleDecision = {
  role: Role;
  source: RoleSource;
  reason: DecideReason;
  matched: string[];
};

/**
 * Role of a user logging in with OIDC.
 *
 * - new users: admin if member of an admin group, otherwise client
 * - existing users with a manual role are never changed
 * - existing OIDC managed users are recalculated, unless role mapping is not
 *   configured or the groups claim is missing (keep the current role)
 *
 * The "last admin" protection is applied by the caller (needs the database).
 */
export function decideOidcRole(input: {
  isNewUser: boolean;
  currentRole?: Role;
  roleSource?: RoleSource;
  adminGroups: readonly string[];
  /** null = claim missing */
  groups: readonly string[] | null;
}): RoleDecision {
  const matched =
    input.groups === null
      ? []
      : matchAdminGroups(input.groups, input.adminGroups);

  if (input.isNewUser) {
    if (matched.length > 0) {
      return {
        role: roles.ADMIN,
        source: 'oidc',
        reason: 'new_user_admin_group',
        matched,
      };
    }
    return {
      role: roles.CLIENT,
      source: 'oidc',
      reason: 'new_user_default',
      matched,
    };
  }

  const currentRole = input.currentRole ?? roles.CLIENT;
  const source = input.roleSource ?? 'manual';

  if (source === 'manual') {
    return { role: currentRole, source, reason: 'manual', matched };
  }
  if (input.adminGroups.length === 0) {
    return { role: currentRole, source, reason: 'no_admin_groups', matched };
  }
  if (input.groups === null) {
    return { role: currentRole, source, reason: 'claim_missing', matched };
  }

  if (matched.length > 0) {
    return { role: roles.ADMIN, source, reason: 'groups_matched', matched };
  }
  return { role: roles.CLIENT, source, reason: 'groups_not_matched', matched };
}
