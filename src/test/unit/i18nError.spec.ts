import { describe, expect, test } from 'vitest';
import { createError } from 'h3';

import en from '../../i18n/locales/en.json';
import zhCN from '../../i18n/locales/zh-CN.json';

import { errorTranslationOf } from '#server/utils/i18nError';
import { USER_ADMIN_ERRORS } from '#server/utils/userAdmin';

function has(messages: unknown, key: string) {
  let current: unknown = messages;
  for (const part of key.split('.')) {
    if (current === null || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string';
}

describe('errorTranslationOf', () => {
  test('http errors by statusMessage', () => {
    expect(
      errorTranslationOf(
        createError({ statusCode: 403, statusMessage: 'Permission denied' })
      )
    ).toEqual({ key: 'error.permissionDenied' });
    expect(
      errorTranslationOf(
        createError({
          statusCode: 401,
          statusMessage: 'Auto registration is disabled',
        })
      )
    ).toEqual({ key: 'error.oauthAutoRegisterDisabled' });
  });

  test('messages with a variable part', () => {
    expect(
      errorTranslationOf(
        createError({
          statusCode: 400,
          statusMessage:
            'Per-Client Firewall requires iptables and ip6tables to be installed on the host system. Please install iptables and ip6tables before enabling this feature.',
        })
      )
    ).toEqual({
      key: 'error.firewallToolsMissing',
      params: { tools: 'iptables and ip6tables' },
    });
  });

  test('plain service errors get a status code', () => {
    expect(errorTranslationOf(new Error('Invalid password'))).toEqual({
      key: 'error.invalidPassword',
      statusCode: 400,
    });
    expect(
      errorTranslationOf(new Error('IPv4 address is not within the CIDR range'))
    ).toEqual({ key: 'error.ipv4OutOfRange', statusCode: 400 });
  });

  test('already translated errors keep their key', () => {
    expect(
      errorTranslationOf(
        createError({
          statusCode: 409,
          statusMessage: 'Client limit reached',
          data: { key: 'connect.limitReached', message: 'x' },
        })
      )
    ).toEqual({ key: 'connect.limitReached' });
  });

  test('unknown errors are not translated', () => {
    expect(
      errorTranslationOf(
        createError({ statusCode: 500, statusMessage: 'Something else' })
      )
    ).toBeNull();
    expect(errorTranslationOf(new Error('Database not yet initialized'))).toBe(
      null
    );
    expect(errorTranslationOf('nope')).toBeNull();
  });

  test('every user management error is translated', () => {
    for (const { message } of Object.values(USER_ADMIN_ERRORS)) {
      expect(
        errorTranslationOf(
          createError({ statusCode: 400, statusMessage: message })
        )
      ).not.toBeNull();
    }
  });

  test('every key exists in en and zh-CN', () => {
    const samples: unknown[] = [
      ...[
        'Permission denied',
        'Invalid username or password',
        'User disabled',
        'User is disabled',
        'Password authentication is disabled',
        'Unexpected error',
        'No pending authentication',
        'Missing OAuth State',
        'Auto registration is disabled',
        'User already linked with different account or provider',
        'Email is not verified',
        'No email set',
        'No sub set',
        'Email domain not allowed',
        'Provider is not enabled',
        'Invalid provider',
        'TOTP is already enabled',
        'TOTP is not enabled',
        'Invalid request',
        'Client not found',
        'Client is expired. Please update the expiration date first.',
        'Owner not found',
        'No addresses available',
        'Too many requests',
        'No admin groups configured',
        'Password login is disabled: OIDC must stay enabled and configured',
        'Invalid One Time Link',
        'One Time Link has expired',
        'Invalid state',
        'Invalid step',
        ...Object.values(USER_ADMIN_ERRORS).map((e) => e.message),
      ].map((statusMessage) => createError({ statusCode: 400, statusMessage })),
      ...[
        'Invalid password',
        'Invalid TOTP code',
        'TOTP is already verified',
        'TOTP key is not set',
        'User already exists',
        'Password login not enabled',
        'User already linked with an OAuth provider',
        'OAuth account already linked with another user',
        'IPv4 address is not within the CIDR range',
        'IPv6 address is not within the CIDR range',
      ].map((m) => new Error(m)),
    ];
    for (const err of samples) {
      const tr = errorTranslationOf(err);
      expect(tr).not.toBeNull();
      expect(has(en, tr!.key)).toBe(true);
      expect(has(zhCN, tr!.key)).toBe(true);
    }
    expect(has(en, 'error.oauthFailed')).toBe(true);
    expect(has(zhCN, 'error.oauthFailed')).toBe(true);
  });
});
