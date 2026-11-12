/**
 * Pure helpers for user management (admin panel, OIDC role sync).
 */
import { roles, type Role, type RoleSource } from '#shared/utils/permissions';

export type UserAdminErrorCode =
  'NOT_FOUND' | 'SELF' | 'LAST_ADMIN' | 'NOT_OIDC';

export class UserAdminError extends Error {
  readonly code: UserAdminErrorCode;

  constructor(code: UserAdminErrorCode) {
    super(USER_ADMIN_ERRORS[code].message);
    this.code = code;
  }
}

export const USER_ADMIN_ERRORS: Record<
  UserAdminErrorCode,
  { statusCode: number; message: string }
> = {
  NOT_FOUND: { statusCode: 404, message: 'User not found' },
  SELF: { statusCode: 400, message: 'You cannot change your own account' },
  LAST_ADMIN: {
    statusCode: 409,
    message: 'At least one enabled admin is required',
  },
  NOT_OIDC: {
    statusCode: 400,
    message: 'User is not linked with OIDC',
  },
};

type RoleState = { role: Role; enabled: boolean };

export function isActiveAdmin(user: RoleState) {
  return user.enabled && user.role === roles.ADMIN;
}

/** true if the change turns an enabled admin into a non admin / disabled user */
export function removesActiveAdmin(before: RoleState, after: RoleState) {
  return isActiveAdmin(before) && !isActiveAdmin(after);
}

export function roleKey(role: Role): 'ADMIN' | 'CLIENT' {
  return role === roles.ADMIN ? 'ADMIN' : 'CLIENT';
}

type AuditUser = {
  id: number;
  username: string;
  role: Role;
  roleSource: RoleSource;
  enabled: boolean;
};

/** always logged (not only in debug mode) */
export function logUserChange(
  actor: { id: number; username: string } | 'oidc-sync' | 'cli',
  before: AuditUser,
  after: Pick<AuditUser, 'role' | 'roleSource' | 'enabled'>
) {
  const changes: string[] = [];
  if (before.role !== after.role) {
    changes.push(`role=${roleKey(before.role)}->${roleKey(after.role)}`);
  }
  if (before.roleSource !== after.roleSource) {
    changes.push(`roleSource=${before.roleSource}->${after.roleSource}`);
  }
  if (before.enabled !== after.enabled) {
    changes.push(`enabled=${before.enabled}->${after.enabled}`);
  }
  if (changes.length === 0) {
    return;
  }
  const by =
    typeof actor === 'string'
      ? actor
      : `user=${actor.id}(${JSON.stringify(actor.username)})`;
  console.info(
    `User change: target=${before.id}(${JSON.stringify(before.username)}) by=${by} ${changes.join(' ')}`
  );
}
