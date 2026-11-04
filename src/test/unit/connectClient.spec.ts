import { describe, expect, test } from 'vitest';

import {
  connectClientName,
  isImportableClient,
  pickConnectClient,
} from '#server/utils/connectClient';

function c(
  id: number,
  overrides: Partial<{
    deviceId: string | null;
    privateKey: string;
    isDefault: boolean;
  }> = {}
) {
  return {
    id,
    deviceId: null,
    privateKey: 'key',
    isDefault: false,
    ...overrides,
  };
}

describe('pickConnectClient', () => {
  test('returns null without clients', () => {
    expect(pickConnectClient([])).toBeNull();
  });

  test('takes the oldest (smallest id) client', () => {
    expect(pickConnectClient([c(5), c(2), c(9)])?.id).toBe(2);
  });

  test('prefers the client marked as default', () => {
    expect(pickConnectClient([c(2), c(9, { isDefault: true }), c(3)])?.id).toBe(
      9
    );
  });

  test('skips LiveWireGuard device clients and keyless clients', () => {
    expect(
      pickConnectClient([
        c(1, { deviceId: 'device' }),
        c(2, { privateKey: '' }),
        c(7),
      ])?.id
    ).toBe(7);
    expect(
      pickConnectClient([c(1, { deviceId: 'device', isDefault: true }), c(4)])
        ?.id
    ).toBe(4);
    expect(pickConnectClient([c(1, { deviceId: 'device' })])).toBeNull();
  });

  test('isImportableClient', () => {
    expect(isImportableClient(c(1))).toBe(true);
    expect(isImportableClient(c(1, { privateKey: '' }))).toBe(false);
  });
});

describe('connectClientName', () => {
  test('username plus timestamp', () => {
    expect(connectClientName('alice', new Date(2026, 10, 4, 9, 5))).toBe(
      'alice-20261104-0905'
    );
  });

  test('falls back for empty usernames', () => {
    expect(connectClientName(' ', new Date(2026, 0, 1, 0, 0))).toBe(
      'client-20260101-0000'
    );
  });
});
