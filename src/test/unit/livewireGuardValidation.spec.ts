import { describe, expect, test } from 'vitest';

import {
  isValidDeviceId,
  isValidPublicKey,
} from '#server/utils/livewireGuardValidation';

const VALID_KEY = '0xX3ijyuoeJhiMDAmuvxJUF/0VWt7A17zWYR81vJ9Xc=';

describe('isValidPublicKey', () => {
  test('accepts a real 32 byte base64 key', () => {
    expect(VALID_KEY).toHaveLength(44);
    expect(isValidPublicKey(VALID_KEY)).toBe(true);
  });

  test('accepts keys for every valid trailing character', () => {
    for (const last of 'AEIMQUYcgkosw048'.split('')) {
      const key = VALID_KEY.slice(0, 42) + last + '=';
      expect(isValidPublicKey(key)).toBe(true);
    }
  });

  test('rejects keys that are not 44 chars', () => {
    expect(isValidPublicKey(VALID_KEY.slice(1))).toBe(false);
    expect(isValidPublicKey(`${VALID_KEY}=`)).toBe(false);
  });

  test('rejects an invalid trailing character', () => {
    // trailing char carries only 4 significant bits: 'B' (value 1) is invalid
    expect(isValidPublicKey(`${VALID_KEY.slice(0, 42)}B=`)).toBe(false);
  });

  test('rejects missing padding, url-safe alphabet and non base64', () => {
    expect(isValidPublicKey(VALID_KEY.slice(0, -1))).toBe(false);
    expect(isValidPublicKey(VALID_KEY.replace('/', '_'))).toBe(false);
    expect(isValidPublicKey(`${VALID_KEY.slice(0, 43)}-`)).toBe(false);
    expect(isValidPublicKey('not-a-key')).toBe(false);
  });
});

describe('isValidDeviceId', () => {
  test('accepts a uuid in any case', () => {
    expect(isValidDeviceId('d2b1f0e6-1a2b-4c3d-8e4f-a05b6c7d8e9f')).toBe(true);
    expect(isValidDeviceId('D2B1F0E6-1A2B-4C3D-8E4F-A05B6C7D8E9F')).toBe(true);
  });

  test('rejects non uuid values', () => {
    expect(isValidDeviceId('device-123')).toBe(false);
    expect(isValidDeviceId('d2b1f0e61a2b4c3d8e4fa05b6c7d8e9f')).toBe(false);
    expect(isValidDeviceId('')).toBe(false);
  });
});
