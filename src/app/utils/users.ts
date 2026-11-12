import type { TypedInternalResponse } from 'nitropack/types';

export type AdminUserList = TypedInternalResponse<
  '/api/admin/users',
  unknown,
  'get'
>;

export type AdminUser = AdminUserList['users'][number];

export type UserAction =
  | 'promote'
  | 'demote'
  | 'followOidc'
  | 'disable'
  | 'enable'
  | 'delete';

/** SQLite CURRENT_TIMESTAMP is UTC without timezone */
export function parseDbDate(value: string | null | undefined) {
  if (!value) return null;
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
