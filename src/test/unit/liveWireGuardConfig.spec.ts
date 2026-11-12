import { describe, expect, test } from 'vitest';

import type { ClientType } from '#db/repositories/client/types';
import type { InterfaceType } from '#db/repositories/interface/types';
import type { UserConfigType } from '#db/repositories/userConfig/types';

// wgHelper evaluates WG_ENV (assertEnv) at import time
process.env.PORT ??= '51820';

const { wg } = await import('#server/utils/wgHelper');

const wgInterface = {
  publicKey: 'server-public-key',
} as unknown as InterfaceType;

const userConfig = {
  defaultDns: ['10.8.0.1'],
  defaultAllowedIps: ['10.8.0.0/24'],
  host: 'vpn.example.com',
  port: 51820,
} as unknown as UserConfigType;

const client = {
  name: 'Test',
  ipv4Address: '10.8.0.5',
  ipv6Address: 'fdcc::5',
  privateKey: 'client-private-key',
  publicKey: 'client-public-key',
  preSharedKey: 'preshared-key',
  preUp: '',
  postUp: '',
  preDown: '',
  postDown: '',
  dns: null,
  allowedIps: null,
  mtu: 1420,
  persistentKeepalive: 25,
} as unknown as ClientType;

describe('generateClientConfig omitPrivateKey', () => {
  test('includes the PrivateKey line by default', () => {
    const config = wg.generateClientConfig(wgInterface, userConfig, client, {});

    expect(config).toContain('PrivateKey = client-private-key');
    expect(config).toContain('Address = 10.8.0.5/32, fdcc::5/128');
    expect(config).toContain('DNS = 10.8.0.1');
    expect(config).toContain('PresharedKey = preshared-key');
    expect(config).toContain('Endpoint = vpn.example.com:51820');
  });

  test('omits the PrivateKey line but keeps everything else', () => {
    const config = wg.generateClientConfig(wgInterface, userConfig, client, {
      omitPrivateKey: true,
    });

    expect(config).not.toContain('PrivateKey');
    expect(config).toContain('[Interface]');
    expect(config).toMatch(/\[Interface\]\nAddress = 10\.8\.0\.5\/32/);
    expect(config).toContain('PresharedKey = preshared-key');
    expect(config).toContain('PublicKey = server-public-key');
    expect(config).toContain('AllowedIPs = 10.8.0.0/24');
    expect(config).toContain('PersistentKeepalive = 25');
  });

  test('default output is unchanged by the new option', () => {
    const before = wg.generateClientConfig(wgInterface, userConfig, client, {});
    const explicit = wg.generateClientConfig(wgInterface, userConfig, client, {
      omitPrivateKey: false,
    });

    expect(before).toBe(explicit);
  });
});
