import { describe, expect, test } from 'vitest';

import {
  ClientLimitReachedError,
  DEFAULT_MAX_CLIENTS_PER_USER,
  clientLimitFor,
  clientUsage,
  isClientLimitReached,
} from '#server/utils/clientLimit';
import { roles } from '#shared/utils/permissions';

const admin = { role: roles.ADMIN };
const user = { role: roles.CLIENT };

describe('clientLimitFor', () => {
  test('default is 5', () => {
    expect(DEFAULT_MAX_CLIENTS_PER_USER).toBe(5);
    expect(clientLimitFor(user, DEFAULT_MAX_CLIENTS_PER_USER)).toBe(5);
  });

  test('admins are never limited', () => {
    expect(clientLimitFor(admin, 5)).toBeNull();
    expect(clientLimitFor(admin, 1)).toBeNull();
  });

  test('0 (or an invalid value) means unlimited', () => {
    expect(clientLimitFor(user, 0)).toBeNull();
    expect(clientLimitFor(user, -1)).toBeNull();
    expect(clientLimitFor(user, 2.5)).toBeNull();
    expect(clientLimitFor(user, Number.NaN)).toBeNull();
  });
});

describe('isClientLimitReached', () => {
  test('reached at the limit, not below', () => {
    expect(isClientLimitReached(4, 5)).toBe(false);
    expect(isClientLimitReached(5, 5)).toBe(true);
    // limit lowered below the existing clients
    expect(isClientLimitReached(7, 5)).toBe(true);
  });

  test('unlimited is never reached', () => {
    expect(isClientLimitReached(1000, null)).toBe(false);
  });
});

describe('clientUsage', () => {
  test('usage for the UI', () => {
    expect(clientUsage(3, 5)).toEqual({ used: 3, max: 5, reached: false });
    expect(clientUsage(5, 5)).toEqual({ used: 5, max: 5, reached: true });
    expect(clientUsage(3, null)).toBeNull();
  });
});

describe('ClientLimitReachedError', () => {
  test('carries limit and count', () => {
    const err = new ClientLimitReachedError(5, 5);
    expect(err.limit).toBe(5);
    expect(err.count).toBe(5);
    expect(err.message).toBe('Client limit reached (5/5)');
  });
});
