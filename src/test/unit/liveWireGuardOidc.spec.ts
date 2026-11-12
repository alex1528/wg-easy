import { beforeEach, describe, expect, test, vi } from 'vitest';

const { jwtVerify, createRemoteJWKSet } = vi.hoisted(() => ({
  jwtVerify: vi.fn(),
  createRemoteJWKSet: vi.fn(),
}));

vi.mock('jose', () => ({ jwtVerify, createRemoteJWKSet }));

const { discovery, fetchUserInfo, skipSubjectCheck } = vi.hoisted(() => ({
  discovery: vi.fn(),
  fetchUserInfo: vi.fn(),
  skipSubjectCheck: Symbol('skipSubjectCheck'),
}));

vi.mock('openid-client', () => ({
  discovery,
  fetchUserInfo,
  skipSubjectCheck,
}));

const { getEffectiveOidcConfig } = vi.hoisted(() => ({
  getEffectiveOidcConfig: vi.fn(),
}));

vi.mock('#server/utils/oidcRuntime', () => ({ getEffectiveOidcConfig }));

function oidcConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    friendlyName: 'OIDC',
    server: 'https://idp.example.com',
    clientId: 'wg-easy-client',
    clientSecret: 'secret',
    isConfigured: true,
    app: {
      clientId: 'wg-easy-client',
      clientSecret: 'secret',
      scopes: ['openid'],
      redirectUri: 'app:/cb',
      endpointUrl: null,
    },
    ...overrides,
  };
}

const IDP = {
  issuer: 'https://idp.example.com',
  jwks_uri: 'https://idp.example.com/jwks',
};

function mockDiscovery() {
  discovery.mockResolvedValue({
    serverMetadata: () => IDP,
  });
}

/**
 * the module caches discovery for 15 min: import it fresh per test
 */
async function importFresh() {
  vi.resetModules();
  return await import('#server/utils/liveWireGuardOidc');
}

const JWT = 'a.b.c';
const OPAQUE = 'opaque-token';

function jwtPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'sub-1',
    email: 'user@example.com',
    email_verified: true,
    aud: 'livewireguard',
    iss: IDP.issuer,
    exp: 9999999999,
    ...overrides,
  };
}

beforeEach(() => {
  jwtVerify.mockReset();
  createRemoteJWKSet.mockReset().mockReturnValue(Symbol('jwks'));
  discovery.mockReset();
  fetchUserInfo.mockReset();
  mockDiscovery();
  getEffectiveOidcConfig.mockReset().mockResolvedValue(oidcConfig());
});

describe('verifyLiveWireGuardToken', () => {
  test('verifies a JWT access_token (audience loose match)', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    jwtVerify.mockResolvedValue({ payload: jwtPayload() });

    const result = await verifyLiveWireGuardToken({
      accessToken: JWT,
      audiences: ['livewireguard', 'wg-easy-client'],
      idTokenAudiences: ['wg-easy-client'],
    });

    expect(result).toEqual({
      ok: true,
      identity: {
        sub: 'sub-1',
        email: 'user@example.com',
        emailVerified: true,
      },
    });
    expect(jwtVerify).toHaveBeenCalledWith(
      JWT,
      expect.anything(),
      expect.objectContaining({ issuer: IDP.issuer, clockTolerance: '30s' })
    );
    expect(fetchUserInfo).not.toHaveBeenCalled();
  });

  test('accepts an access_token with the wg-easy client id as audience', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    jwtVerify.mockResolvedValue({
      payload: jwtPayload({ aud: 'wg-easy-client' }),
    });

    const result = await verifyLiveWireGuardToken({
      accessToken: JWT,
      audiences: ['livewireguard', 'wg-easy-client'],
      idTokenAudiences: ['wg-easy-client'],
    });

    expect(result.ok).toBe(true);
  });

  test('a failing JWT access_token is final: no userinfo fallback', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    jwtVerify.mockRejectedValue(new Error('signature verification failed'));

    const result = await verifyLiveWireGuardToken({
      accessToken: JWT,
      audiences: ['livewireguard', 'wg-easy-client'],
      idTokenAudiences: ['wg-easy-client'],
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    expect(jwtVerify).toHaveBeenCalledTimes(1);
    expect(fetchUserInfo).not.toHaveBeenCalled();
  });

  test('rejects a JWT access_token with a mismatched audience', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    jwtVerify.mockResolvedValue({ payload: jwtPayload({ aud: 'other-app' }) });

    const result = await verifyLiveWireGuardToken({
      accessToken: JWT,
      audiences: ['livewireguard', 'wg-easy-client'],
      idTokenAudiences: ['wg-easy-client'],
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  test('verifies the id_token when the access_token is opaque', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    jwtVerify.mockResolvedValue({
      payload: jwtPayload({ aud: 'wg-easy-client' }),
    });

    const result = await verifyLiveWireGuardToken({
      accessToken: OPAQUE,
      idToken: JWT,
      audiences: ['livewireguard', 'wg-easy-client'],
      idTokenAudiences: ['wg-easy-client'],
    });

    expect(result).toEqual({
      ok: true,
      identity: {
        sub: 'sub-1',
        email: 'user@example.com',
        emailVerified: true,
      },
    });
    expect(jwtVerify).toHaveBeenCalledWith(
      JWT,
      expect.anything(),
      expect.objectContaining({ issuer: IDP.issuer })
    );
    expect(fetchUserInfo).not.toHaveBeenCalled();
  });

  test('a failing id_token is final: no userinfo fallback', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    jwtVerify.mockRejectedValue(new Error('expired'));

    const result = await verifyLiveWireGuardToken({
      accessToken: OPAQUE,
      idToken: JWT,
      audiences: ['livewireguard', 'wg-easy-client'],
      idTokenAudiences: ['wg-easy-client'],
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    expect(fetchUserInfo).not.toHaveBeenCalled();
  });

  test('validates an opaque access_token via userinfo', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    fetchUserInfo.mockResolvedValue({
      sub: 'sub-2',
      email: 'user2@example.com',
      email_verified: true,
    });

    const result = await verifyLiveWireGuardToken({
      accessToken: OPAQUE,
      audiences: ['livewireguard', 'wg-easy-client'],
      idTokenAudiences: ['wg-easy-client'],
    });

    expect(result).toEqual({
      ok: true,
      identity: {
        sub: 'sub-2',
        email: 'user2@example.com',
        emailVerified: true,
      },
    });
    expect(fetchUserInfo).toHaveBeenCalledWith(
      expect.anything(),
      OPAQUE,
      skipSubjectCheck
    );
  });

  test('userinfo failure yields invalid_token', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    fetchUserInfo.mockRejectedValue(new Error('userinfo failed'));

    const result = await verifyLiveWireGuardToken({
      accessToken: OPAQUE,
      audiences: ['livewireguard', 'wg-easy-client'],
      idTokenAudiences: ['wg-easy-client'],
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  test('discovery failure yields server_misconfigured', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    discovery.mockRejectedValue(new Error('discovery failed'));

    const result = await verifyLiveWireGuardToken({
      accessToken: JWT,
      audiences: ['livewireguard', 'wg-easy-client'],
      idTokenAudiences: ['wg-easy-client'],
    });

    expect(result).toEqual({ ok: false, reason: 'server_misconfigured' });
  });

  test('missing OIDC configuration yields server_misconfigured', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    getEffectiveOidcConfig.mockResolvedValue(
      oidcConfig({ server: null, clientId: null })
    );

    const result = await verifyLiveWireGuardToken({
      accessToken: OPAQUE,
      audiences: ['livewireguard'],
      idTokenAudiences: ['wg-easy-client'],
    });

    expect(result).toEqual({ ok: false, reason: 'server_misconfigured' });
  });

  test('accepts an id_token issued to the app client id', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    jwtVerify.mockResolvedValue({
      payload: jwtPayload({ aud: 'livewireguard-app' }),
    });

    const result = await verifyLiveWireGuardToken({
      accessToken: OPAQUE,
      idToken: JWT,
      audiences: ['livewireguard', 'wg-easy-client', 'livewireguard-app'],
      idTokenAudiences: ['wg-easy-client', 'livewireguard-app'],
    });

    expect(result.ok).toBe(true);
  });

  test('rejects an id_token issued to an unknown client', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    jwtVerify.mockResolvedValue({
      payload: jwtPayload({ aud: 'other-app' }),
    });

    const result = await verifyLiveWireGuardToken({
      accessToken: OPAQUE,
      idToken: JWT,
      audiences: ['livewireguard'],
      idTokenAudiences: ['wg-easy-client', 'livewireguard-app'],
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  test('discovery is redone when the OIDC settings change', async () => {
    const { verifyLiveWireGuardToken } = await importFresh();
    jwtVerify.mockResolvedValue({ payload: jwtPayload() });
    const input = {
      accessToken: JWT,
      audiences: ['livewireguard'],
      idTokenAudiences: ['wg-easy-client'],
    };

    await verifyLiveWireGuardToken(input);
    await verifyLiveWireGuardToken(input);
    expect(discovery).toHaveBeenCalledTimes(1);

    getEffectiveOidcConfig.mockResolvedValue(
      oidcConfig({ server: 'https://other-idp.example.com' })
    );
    await verifyLiveWireGuardToken(input);
    expect(discovery).toHaveBeenCalledTimes(2);
  });
});
