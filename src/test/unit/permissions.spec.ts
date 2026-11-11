import { describe, expect, test } from 'vitest';

import { hasPermissions, roles } from '#shared/utils/permissions';

const admin = { id: 1, role: roles.ADMIN };
const client = { id: 2, role: roles.CLIENT };
const ownClient = { id: 10, userId: 2 };
const otherClient = { id: 11, userId: 1 };

describe('permissions', () => {
  test('admin can do everything', () => {
    for (const action of [
      'view',
      'create',
      'update',
      'updateAdvanced',
      'toggle',
      'delete',
    ] as const) {
      expect(hasPermissions(admin, 'clients', action, otherClient)).toBe(true);
    }
    expect(hasPermissions(admin, 'users', 'view')).toBe(true);
    expect(hasPermissions(admin, 'users', 'update')).toBe(true);
    expect(hasPermissions(admin, 'admin', 'any')).toBe(true);
  });

  test('client can only rename / view / delete own clients', () => {
    expect(hasPermissions(client, 'clients', 'view', ownClient)).toBe(true);
    expect(hasPermissions(client, 'clients', 'update', ownClient)).toBe(true);
    expect(hasPermissions(client, 'clients', 'delete', ownClient)).toBe(true);

    expect(hasPermissions(client, 'clients', 'view', otherClient)).toBe(false);
    expect(hasPermissions(client, 'clients', 'update', otherClient)).toBe(
      false
    );
    expect(hasPermissions(client, 'clients', 'delete', otherClient)).toBe(
      false
    );
  });

  test('client has no advanced / toggle / create / user permissions', () => {
    expect(hasPermissions(client, 'clients', 'updateAdvanced', ownClient)).toBe(
      false
    );
    expect(hasPermissions(client, 'clients', 'toggle', ownClient)).toBe(false);
    expect(hasPermissions(client, 'clients', 'create')).toBe(false);
    expect(hasPermissions(client, 'users', 'view')).toBe(false);
    expect(hasPermissions(client, 'users', 'update')).toBe(false);
    expect(hasPermissions(client, 'admin', 'any')).toBe(false);
  });
});
