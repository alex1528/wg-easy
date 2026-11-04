import { describe, expect, test } from 'vitest';

import { OidcSettingsUpdateSchema } from '#db/repositories/oidcSettings/types';

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

describe('OidcSettingsUpdateSchema', () => {
  test('accepts all-null (everything from env)', () => {
    const r = OidcSettingsUpdateSchema.parse(base);
    expect(r.server).toBeNull();
    expect(r.clientSecret).toBeUndefined();
  });

  test('empty strings become null', () => {
    const r = OidcSettingsUpdateSchema.parse({
      ...base,
      server: '  ',
      friendlyName: '',
    });
    expect(r.server).toBeNull();
    expect(r.friendlyName).toBeNull();
  });

  test('validates urls', () => {
    expect(
      OidcSettingsUpdateSchema.safeParse({ ...base, server: 'not a url' })
        .success
    ).toBe(false);
    expect(
      OidcSettingsUpdateSchema.safeParse({
        ...base,
        server: 'https://idp.example.com/application/o/wg/',
        endpointUrl: 'https://vpn.example.com/api/livewireguard/config',
      }).success
    ).toBe(true);
  });

  test('accepts custom-scheme redirect uris', () => {
    const r = OidcSettingsUpdateSchema.parse({
      ...base,
      appRedirectUri:
        'com.wuxichaorongtechnologycoltd.livewireguard:/oidc/callback',
    });
    expect(r.appRedirectUri).toContain('livewireguard');
    expect(
      OidcSettingsUpdateSchema.safeParse({ ...base, appRedirectUri: 'nope' })
        .success
    ).toBe(false);
  });

  test('scopes must contain openid and are normalized', () => {
    expect(
      OidcSettingsUpdateSchema.safeParse({
        ...base,
        appScopes: 'email profile',
      }).success
    ).toBe(false);
    const r = OidcSettingsUpdateSchema.parse({
      ...base,
      appScopes: 'openid,  email profile',
    });
    expect(r.appScopes).toBe('openid email profile');
  });

  test('secrets: undefined keeps, null / empty clears, string sets', () => {
    expect(OidcSettingsUpdateSchema.parse(base).clientSecret).toBeUndefined();
    expect(
      OidcSettingsUpdateSchema.parse({ ...base, clientSecret: null })
        .clientSecret
    ).toBeNull();
    expect(
      OidcSettingsUpdateSchema.parse({ ...base, clientSecret: '' }).clientSecret
    ).toBeNull();
    expect(
      OidcSettingsUpdateSchema.parse({ ...base, appClientSecret: 's3cret' })
        .appClientSecret
    ).toBe('s3cret');
  });
});
