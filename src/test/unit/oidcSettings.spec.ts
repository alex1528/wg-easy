import { describe, expect, test } from 'vitest';

import {
  DEFAULT_APP_REDIRECT_URI,
  DEFAULT_APP_SCOPES,
  SETUP_LINK_PREFIX,
  buildSetupLink,
  buildSetupPayload,
  resolveOidcConfig,
  revisionOf,
  serializeSetupPayload,
  type OidcDbRow,
  type OidcEnv,
} from '#server/utils/oidcSettings';

const env: OidcEnv = {
  enabled: true,
  friendlyName: 'Authentik',
  server: 'https://idp.example.com/app/',
  clientId: 'panel-client',
  clientSecret: 'panel-secret',
};

const emptyRow: OidcDbRow = {
  enabled: null,
  friendlyName: null,
  server: null,
  clientId: null,
  clientSecret: null,
  appClientId: null,
  appClientSecret: null,
  appScopes: null,
  appRedirectUri: null,
  endpointUrl: null,
};

describe('resolveOidcConfig', () => {
  test('uses env when there is no DB row', () => {
    const c = resolveOidcConfig(env, null);
    expect(c.enabled).toBe(true);
    expect(c.friendlyName).toBe('Authentik');
    expect(c.server).toBe(env.server);
    expect(c.clientId).toBe('panel-client');
    expect(c.clientSecret).toBe('panel-secret');
    expect(c.isConfigured).toBe(true);
    expect(c.sources.server).toBe('env');
  });

  test('empty DB row behaves like no row', () => {
    expect(resolveOidcConfig(env, emptyRow)).toEqual(
      resolveOidcConfig(env, null)
    );
  });

  test('DB overrides individual fields', () => {
    const c = resolveOidcConfig(env, {
      ...emptyRow,
      server: 'https://other.example.com',
      clientSecret: 'db-secret',
    });
    expect(c.server).toBe('https://other.example.com');
    expect(c.sources.server).toBe('db');
    expect(c.clientId).toBe('panel-client');
    expect(c.sources.clientId).toBe('env');
    expect(c.clientSecret).toBe('db-secret');
    expect(c.sources.clientSecret).toBe('db');
  });

  test('whitespace-only DB values fall back to env', () => {
    const c = resolveOidcConfig(env, { ...emptyRow, server: '   ' });
    expect(c.server).toBe(env.server);
  });

  test('enabled: null follows env, true/false override', () => {
    const disabledEnv = { ...env, enabled: false };
    expect(resolveOidcConfig(disabledEnv, emptyRow).enabled).toBe(false);
    expect(
      resolveOidcConfig(disabledEnv, { ...emptyRow, enabled: true }).enabled
    ).toBe(true);
    const off = resolveOidcConfig(env, { ...emptyRow, enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.isConfigured).toBe(false);
    expect(off.sources.enabled).toBe('db');
  });

  test('isConfigured requires server, client id and secret', () => {
    expect(
      resolveOidcConfig({ ...env, clientSecret: undefined }, null).isConfigured
    ).toBe(false);
    expect(
      resolveOidcConfig(
        { enabled: true },
        {
          ...emptyRow,
          server: 'https://idp',
          clientId: 'a',
          clientSecret: 'b',
        }
      ).isConfigured
    ).toBe(true);
  });

  test('app client falls back to the panel client (id and secret)', () => {
    const c = resolveOidcConfig(env, null);
    expect(c.app.clientId).toBe('panel-client');
    expect(c.app.clientSecret).toBe('panel-secret');
  });

  test('own app client id does not inherit the panel secret', () => {
    const c = resolveOidcConfig(env, { ...emptyRow, appClientId: 'app' });
    expect(c.app.clientId).toBe('app');
    expect(c.app.clientSecret).toBeNull();
    const withSecret = resolveOidcConfig(env, {
      ...emptyRow,
      appClientId: 'app',
      appClientSecret: 'app-secret',
    });
    expect(withSecret.app.clientSecret).toBe('app-secret');
  });

  test('scopes / redirect uri defaults and overrides', () => {
    const c = resolveOidcConfig(env, null);
    expect(c.app.scopes).toEqual(DEFAULT_APP_SCOPES);
    expect(c.app.redirectUri).toBe(DEFAULT_APP_REDIRECT_URI);
    expect(c.app.endpointUrl).toBeNull();

    const o = resolveOidcConfig(env, {
      ...emptyRow,
      appScopes: 'openid  email,profile',
      appRedirectUri: 'my.app:/cb',
      endpointUrl: 'https://vpn.example.com/api/livewireguard/config',
    });
    expect(o.app.scopes).toEqual(['openid', 'email', 'profile']);
    expect(o.app.redirectUri).toBe('my.app:/cb');
    expect(o.app.endpointUrl).toBe(
      'https://vpn.example.com/api/livewireguard/config'
    );
  });

  test('friendly name defaults to OIDC', () => {
    expect(resolveOidcConfig({ enabled: true }, null).friendlyName).toBe(
      'OIDC'
    );
  });
});

describe('buildSetupPayload', () => {
  const endpointUrl = 'https://panel.example.com/api/livewireguard/config';

  test('v1 payload with all fields including the secret', () => {
    const payload = buildSetupPayload(resolveOidcConfig(env, null), {
      endpointUrl,
      issuer: 'https://idp.example.com/app/',
    });
    expect(payload).toEqual({
      type: 'livewireguard-setup',
      v: 1,
      name: 'Authentik',
      issuer: 'https://idp.example.com/app/',
      client_id: 'panel-client',
      client_secret: 'panel-secret',
      scopes: DEFAULT_APP_SCOPES,
      redirect_uri: DEFAULT_APP_REDIRECT_URI,
      endpoint: endpointUrl,
    });
    // fixed key order
    expect(Object.keys(payload)).toEqual([
      'type',
      'v',
      'name',
      'issuer',
      'client_id',
      'client_secret',
      'scopes',
      'redirect_uri',
      'endpoint',
    ]);
  });

  test('omits empty fields', () => {
    const payload = buildSetupPayload(
      resolveOidcConfig(env, { ...emptyRow, appClientId: 'public-app' }),
      { endpointUrl }
    );
    expect(payload.client_id).toBe('public-app');
    expect('client_secret' in payload).toBe(false);
  });

  test('issuer falls back to the server url', () => {
    const payload = buildSetupPayload(resolveOidcConfig(env, null), {
      endpointUrl,
      issuer: null,
    });
    expect(payload.issuer).toBe(env.server);
  });

  test('configured endpoint url wins over the request host', () => {
    const payload = buildSetupPayload(
      resolveOidcConfig(env, {
        ...emptyRow,
        endpointUrl: 'https://vpn.example.com/api/livewireguard/config',
      }),
      { endpointUrl }
    );
    expect(payload.endpoint).toBe(
      'https://vpn.example.com/api/livewireguard/config'
    );
  });

  test('revision is stable and changes with the payload', () => {
    const config = resolveOidcConfig(env, null);
    const a = serializeSetupPayload(buildSetupPayload(config, { endpointUrl }));
    const b = serializeSetupPayload(buildSetupPayload(config, { endpointUrl }));
    expect(revisionOf(a)).toBe(revisionOf(b));
    expect(revisionOf(a)).toHaveLength(12);

    const changed = serializeSetupPayload(
      buildSetupPayload(
        resolveOidcConfig(env, { ...emptyRow, appScopes: 'openid' }),
        { endpointUrl }
      )
    );
    expect(revisionOf(changed)).not.toBe(revisionOf(a));
  });
});

describe('buildSetupLink', () => {
  const endpointUrl = 'https://panel.example.com/api/livewireguard/config';

  test('is livewireguard://setup?d=<base64url JSON> and round-trips', () => {
    const payload = buildSetupPayload(resolveOidcConfig(env, null), {
      endpointUrl,
      issuer: 'https://idp.example.com/app/',
    });
    const link = buildSetupLink(payload);

    expect(link.startsWith(SETUP_LINK_PREFIX)).toBe(true);
    const encoded = link.slice(SETUP_LINK_PREFIX.length);
    // base64url: URL-safe, no padding
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    ).toEqual(payload);
  });

  test('does not show the content in plain text', () => {
    const payload = buildSetupPayload(resolveOidcConfig(env, null), {
      endpointUrl,
    });
    const link = buildSetupLink(payload);
    expect(link).not.toContain('panel-secret');
    expect(link).not.toContain('livewireguard-setup');
  });

  test('keeps non-ASCII names intact', () => {
    const payload = buildSetupPayload(
      resolveOidcConfig({ ...env, friendlyName: '公司单点登录' }, null),
      { endpointUrl }
    );
    const link = buildSetupLink(payload);
    const decoded = JSON.parse(
      Buffer.from(link.slice(SETUP_LINK_PREFIX.length), 'base64url').toString(
        'utf8'
      )
    );
    expect(decoded.name).toBe('公司单点登录');
  });

  test('revision follows the link', () => {
    const a = buildSetupLink(
      buildSetupPayload(resolveOidcConfig(env, null), { endpointUrl })
    );
    const b = buildSetupLink(
      buildSetupPayload(
        resolveOidcConfig(env, { ...emptyRow, appScopes: 'openid' }),
        { endpointUrl }
      )
    );
    expect(revisionOf(a)).not.toBe(revisionOf(b));
  });
});
