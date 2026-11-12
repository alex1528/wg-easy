import { describe, expect, test } from 'vitest';

import {
  USER_ADMIN_ERRORS,
  UserAdminError,
  isActiveAdmin,
  removesActiveAdmin,
  roleKey,
} from '#server/utils/userAdmin';
import { roles } from '#shared/utils/permissions';

describe('userAdmin', () => {
  test('isActiveAdmin', () => {
    expect(isActiveAdmin({ role: roles.ADMIN, enabled: true })).toBe(true);
    expect(isActiveAdmin({ role: roles.ADMIN, enabled: false })).toBe(false);
    expect(isActiveAdmin({ role: roles.CLIENT, enabled: true })).toBe(false);
  });

  test('removesActiveAdmin', () => {
    const admin = { role: roles.ADMIN, enabled: true };
    expect(removesActiveAdmin(admin, { ...admin, role: roles.CLIENT })).toBe(
      true
    );
    expect(removesActiveAdmin(admin, { ...admin, enabled: false })).toBe(true);
    expect(removesActiveAdmin(admin, admin)).toBe(false);
    // already not an active admin
    expect(
      removesActiveAdmin(
        { role: roles.ADMIN, enabled: false },
        { role: roles.CLIENT, enabled: false }
      )
    ).toBe(false);
    expect(
      removesActiveAdmin(
        { role: roles.CLIENT, enabled: true },
        { role: roles.CLIENT, enabled: false }
      )
    ).toBe(false);
  });

  test('roleKey', () => {
    expect(roleKey(roles.ADMIN)).toBe('ADMIN');
    expect(roleKey(roles.CLIENT)).toBe('CLIENT');
  });

  test('errors map to http status codes', () => {
    const err = new UserAdminError('LAST_ADMIN');
    expect(err.code).toBe('LAST_ADMIN');
    expect(USER_ADMIN_ERRORS[err.code].statusCode).toBe(409);
    expect(USER_ADMIN_ERRORS.SELF.statusCode).toBe(400);
    expect(USER_ADMIN_ERRORS.NOT_FOUND.statusCode).toBe(404);
  });
});
