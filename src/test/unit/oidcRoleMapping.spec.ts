import { describe, expect, test } from 'vitest';

import {
  DEFAULT_GROUPS_CLAIM,
  DEFAULT_PANEL_SCOPES,
  normalizeList,
  resolveOidcRoleMapping,
  splitList,
} from '#server/utils/oidcSettings';
import { OidcSettingsUpdateSchema } from '#db/repositories/oidcSettings/types';

describe('normalizeList / splitList', () => {
  test('trims, drops empty values and duplicates', () => {
    expect(normalizeList([' a', 'b ', '', 'a', 3])).toEqual(['a', 'b']);
    expect(splitList('wg-admins, ops,,ops ')).toEqual(['wg-admins', 'ops']);
  });
});

describe('resolveOidcRoleMapping', () => {
  test('defaults', () => {
    const m = resolveOidcRoleMapping({}, null);
    expect(m.adminGroups).toEqual([]);
    expect(m.groupsClaim).toBe(DEFAULT_GROUPS_CLAIM);
    expect(m.panelScopes).toEqual(DEFAULT_PANEL_SCOPES);
    expect(m.sources).toEqual({
      adminGroups: 'none',
      groupsClaim: 'default',
      panelScopes: 'default',
    });
  });

  test('env values', () => {
    const m = resolveOidcRoleMapping(
      {
        adminGroups: 'wg-admins,ops',
        groupsClaim: 'realm_access.roles',
        panelScopes: 'openid email profile groups',
      },
      null
    );
    expect(m.adminGroups).toEqual(['wg-admins', 'ops']);
    expect(m.groupsClaim).toBe('realm_access.roles');
    expect(m.panelScopes).toEqual(['openid', 'email', 'profile', 'groups']);
    expect(m.sources.adminGroups).toBe('env');
  });

  test('db overrides env, empty db values fall back', () => {
    const env = { adminGroups: 'env-group', groupsClaim: 'roles' };
    expect(
      resolveOidcRoleMapping(env, {
        adminGroups: ['db-group'],
        groupsClaim: 'groups',
        panelScopes: null,
      })
    ).toMatchObject({
      adminGroups: ['db-group'],
      groupsClaim: 'groups',
      sources: { adminGroups: 'db', groupsClaim: 'db' },
    });
    expect(
      resolveOidcRoleMapping(env, { adminGroups: [], groupsClaim: ' ' })
    ).toMatchObject({
      adminGroups: ['env-group'],
      groupsClaim: 'roles',
      sources: { adminGroups: 'env', groupsClaim: 'env' },
    });
  });

  test('panel scopes always contain openid', () => {
    expect(
      resolveOidcRoleMapping({ panelScopes: 'email,groups' }, null).panelScopes
    ).toEqual(['openid', 'email', 'groups']);
  });
});

describe('OidcSettingsUpdateSchema role mapping', () => {
  const base = {
    enabled: null,
    friendlyName: null,
    server: null,
    clientId: null,
    appClientId: null,
    appScopes: null,
    appRedirectUri: null,
    endpointUrl: null,
  };

  test('fields are optional (keep stored value)', () => {
    const r = OidcSettingsUpdateSchema.parse(base);
    expect(r.adminGroups).toBeUndefined();
    expect(r.groupsClaim).toBeUndefined();
    expect(r.panelScopes).toBeUndefined();
  });

  test('admin groups are normalized, empty list becomes null', () => {
    expect(
      OidcSettingsUpdateSchema.parse({
        ...base,
        adminGroups: [' ops ', '', 'ops', 'wg-admins'],
      }).adminGroups
    ).toEqual(['ops', 'wg-admins']);
    expect(
      OidcSettingsUpdateSchema.parse({ ...base, adminGroups: ['', ' '] })
        .adminGroups
    ).toBeNull();
    expect(
      OidcSettingsUpdateSchema.parse({ ...base, adminGroups: null }).adminGroups
    ).toBeNull();
  });

  test('admin groups limits', () => {
    expect(
      OidcSettingsUpdateSchema.safeParse({
        ...base,
        adminGroups: Array.from({ length: 51 }, (_, i) => `g${i}`),
      }).success
    ).toBe(false);
    expect(
      OidcSettingsUpdateSchema.safeParse({
        ...base,
        adminGroups: ['x'.repeat(257)],
      }).success
    ).toBe(false);
  });

  test('groups claim must not contain spaces', () => {
    expect(
      OidcSettingsUpdateSchema.safeParse({ ...base, groupsClaim: 'a b' })
        .success
    ).toBe(false);
    expect(
      OidcSettingsUpdateSchema.parse({ ...base, groupsClaim: '' }).groupsClaim
    ).toBeNull();
    expect(
      OidcSettingsUpdateSchema.parse({
        ...base,
        groupsClaim: 'https://example.com/groups',
      }).groupsClaim
    ).toBe('https://example.com/groups');
  });

  test('panel scopes must contain openid', () => {
    expect(
      OidcSettingsUpdateSchema.safeParse({ ...base, panelScopes: 'groups' })
        .success
    ).toBe(false);
    expect(
      OidcSettingsUpdateSchema.parse({
        ...base,
        panelScopes: 'openid,email  groups',
      }).panelScopes
    ).toBe('openid email groups');
  });
});
