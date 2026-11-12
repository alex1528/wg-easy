import { describe, expect, test } from 'vitest';

import {
  decideOidcRole,
  extractGroups,
  getClaim,
  matchAdminGroups,
  mergeClaims,
} from '#server/utils/oidcRole';
import { roles } from '#shared/utils/permissions';

describe('getClaim', () => {
  test('reads a top level claim', () => {
    expect(getClaim({ groups: ['a'] }, 'groups')).toEqual(['a']);
  });

  test('reads a namespaced claim by its exact key', () => {
    const claims = { 'https://example.com/groups': ['a'] };
    expect(getClaim(claims, 'https://example.com/groups')).toEqual(['a']);
  });

  test('reads a dotted path', () => {
    const claims = { realm_access: { roles: ['admin', 'user'] } };
    expect(getClaim(claims, 'realm_access.roles')).toEqual(['admin', 'user']);
  });

  test('exact key wins over the dotted path', () => {
    const claims = { 'a.b': 'exact', a: { b: 'nested' } };
    expect(getClaim(claims, 'a.b')).toBe('exact');
  });

  test('missing path', () => {
    expect(getClaim({ a: { b: 1 } }, 'a.c')).toBeUndefined();
    expect(getClaim({ a: 'x' }, 'a.b')).toBeUndefined();
    expect(getClaim({}, 'groups')).toBeUndefined();
  });

  test('does not read inherited properties', () => {
    expect(getClaim({}, 'constructor')).toBeUndefined();
    expect(getClaim({ a: {} }, 'a.toString')).toBeUndefined();
  });
});

describe('extractGroups', () => {
  test('array of strings, trimmed and deduplicated', () => {
    expect(
      extractGroups({ groups: [' a ', 'b', 'a', '', 1, null] }, 'groups')
    ).toEqual(['a', 'b']);
  });

  test('single string', () => {
    expect(extractGroups({ groups: 'admins' }, 'groups')).toEqual(['admins']);
    expect(extractGroups({ groups: '  ' }, 'groups')).toEqual([]);
  });

  test('empty array is not missing', () => {
    expect(extractGroups({ groups: [] }, 'groups')).toEqual([]);
  });

  test('missing or unusable claim is null', () => {
    expect(extractGroups({}, 'groups')).toBeNull();
    expect(extractGroups({ groups: 42 }, 'groups')).toBeNull();
    expect(extractGroups({ groups: { a: 1 } }, 'groups')).toBeNull();
  });
});

describe('mergeClaims', () => {
  test('later sources win', () => {
    expect(
      mergeClaims({ groups: ['id'], sub: '1' }, undefined, { groups: ['ui'] })
    ).toEqual({ groups: ['ui'], sub: '1' });
  });
});

describe('matchAdminGroups', () => {
  test('case sensitive match', () => {
    expect(matchAdminGroups(['Admins', 'ops'], ['admins', 'ops'])).toEqual([
      'ops',
    ]);
  });

  test('ignores a leading slash (keycloak group paths)', () => {
    expect(matchAdminGroups(['/wg-admins'], ['wg-admins'])).toEqual([
      '/wg-admins',
    ]);
    expect(matchAdminGroups(['wg-admins'], ['/wg-admins'])).toEqual([
      'wg-admins',
    ]);
  });

  test('no admin groups', () => {
    expect(matchAdminGroups(['a'], [])).toEqual([]);
  });
});

describe('decideOidcRole', () => {
  const adminGroups = ['wg-admins', 'ops'];

  test('new user in an admin group is admin', () => {
    const d = decideOidcRole({
      isNewUser: true,
      adminGroups,
      groups: ['employees', 'ops'],
    });
    expect(d).toEqual({
      role: roles.ADMIN,
      source: 'oidc',
      reason: 'new_user_admin_group',
      matched: ['ops'],
    });
  });

  test('new user without admin group is client', () => {
    const d = decideOidcRole({
      isNewUser: true,
      adminGroups,
      groups: ['employees'],
    });
    expect(d.role).toBe(roles.CLIENT);
    expect(d.source).toBe('oidc');
  });

  test('new user is never admin without admin groups or groups', () => {
    expect(
      decideOidcRole({ isNewUser: true, adminGroups: [], groups: ['ops'] }).role
    ).toBe(roles.CLIENT);
    expect(
      decideOidcRole({ isNewUser: true, adminGroups, groups: null }).role
    ).toBe(roles.CLIENT);
  });

  test('manual role is never changed', () => {
    const promoted = decideOidcRole({
      isNewUser: false,
      currentRole: roles.ADMIN,
      roleSource: 'manual',
      adminGroups,
      groups: [],
    });
    expect(promoted.role).toBe(roles.ADMIN);
    expect(promoted.reason).toBe('manual');

    const demoted = decideOidcRole({
      isNewUser: false,
      currentRole: roles.CLIENT,
      roleSource: 'manual',
      adminGroups,
      groups: ['ops'],
    });
    expect(demoted.role).toBe(roles.CLIENT);
  });

  test('oidc managed user is promoted and demoted', () => {
    expect(
      decideOidcRole({
        isNewUser: false,
        currentRole: roles.CLIENT,
        roleSource: 'oidc',
        adminGroups,
        groups: ['wg-admins'],
      })
    ).toMatchObject({ role: roles.ADMIN, reason: 'groups_matched' });
    expect(
      decideOidcRole({
        isNewUser: false,
        currentRole: roles.ADMIN,
        roleSource: 'oidc',
        adminGroups,
        groups: ['employees'],
      })
    ).toMatchObject({ role: roles.CLIENT, reason: 'groups_not_matched' });
  });

  test('missing claim keeps the role', () => {
    expect(
      decideOidcRole({
        isNewUser: false,
        currentRole: roles.ADMIN,
        roleSource: 'oidc',
        adminGroups,
        groups: null,
      })
    ).toMatchObject({ role: roles.ADMIN, reason: 'claim_missing' });
  });

  test('empty groups claim demotes', () => {
    expect(
      decideOidcRole({
        isNewUser: false,
        currentRole: roles.ADMIN,
        roleSource: 'oidc',
        adminGroups,
        groups: [],
      }).role
    ).toBe(roles.CLIENT);
  });

  test('without admin groups the role is kept', () => {
    expect(
      decideOidcRole({
        isNewUser: false,
        currentRole: roles.ADMIN,
        roleSource: 'oidc',
        adminGroups: [],
        groups: ['employees'],
      })
    ).toMatchObject({ role: roles.ADMIN, reason: 'no_admin_groups' });
  });
});
