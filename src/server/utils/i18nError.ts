/**
 * Translated error messages for the UI.
 *
 * `statusMessage` stays English (HTTP status line, logs, API clients),
 * `message` / `data.message` is translated with the request locale
 * (cookie / Accept-Language, see i18n/localeDetector.ts). The frontend shows
 * `data.message` in its toasts.
 */
import { useTranslation } from '@intlify/h3';
import { createError, isError, sendRedirect } from 'h3';
import type { EventHandlerRequest, H3Event } from 'h3';

type Params = Record<string, string | number>;

type ErrorDef = { key: string; statusCode?: number };

/** HTTP errors, by statusMessage (status code is kept) */
const HTTP_ERRORS: Record<string, ErrorDef> = {
  'Permission denied': { key: 'error.permissionDenied' },
  'Invalid username or password': { key: 'error.invalidCredentials' },
  'User disabled': { key: 'error.userDisabled' },
  'User is disabled': { key: 'error.userDisabled' },
  'Password authentication is disabled': {
    key: 'error.passwordAuthDisabled',
  },
  'Unexpected error': { key: 'error.unexpected' },
  'No pending authentication': { key: 'error.noPendingLogin' },
  'Missing OAuth State': { key: 'error.oauthStateMissing' },
  'Auto registration is disabled': { key: 'error.oauthAutoRegisterDisabled' },
  'User already linked with different account or provider': {
    key: 'error.oauthAlreadyLinked',
  },
  'Email is not verified': { key: 'error.oauthEmailNotVerified' },
  'No email set': { key: 'error.oauthNoEmail' },
  'No sub set': { key: 'error.oauthNoSub' },
  "Can't get subject": { key: 'error.oauthNoSub' },
  'Email domain not allowed': { key: 'error.oauthDomainNotAllowed' },
  'Provider is not enabled': { key: 'error.oauthProviderDisabled' },
  'Invalid provider': { key: 'error.oauthInvalidProvider' },
  'TOTP is already enabled': { key: 'error.totpAlreadyEnabled' },
  'TOTP is not enabled': { key: 'error.totpNotEnabled' },
  'Invalid request': { key: 'error.invalidRequest' },
  'Client not found': { key: 'error.clientNotFound' },
  'Client is expired. Please update the expiration date first.': {
    key: 'error.clientExpired',
  },
  'Owner not found': { key: 'error.ownerNotFound' },
  'No addresses available': { key: 'error.noAddresses' },
  'Too many requests': { key: 'error.tooManyRequests' },
  'User not found': { key: 'error.userNotFound' },
  'You cannot change your own account': { key: 'error.selfChange' },
  'At least one enabled admin is required': { key: 'error.lastAdmin' },
  'User is not linked with OIDC': { key: 'error.notOidcUser' },
  'No admin groups configured': { key: 'error.noAdminGroups' },
  'Password login is disabled: OIDC must stay enabled and configured': {
    key: 'error.oidcRequired',
  },
  'Invalid One Time Link': { key: 'error.oneTimeLinkInvalid' },
  'One Time Link has expired': { key: 'error.oneTimeLinkExpired' },
  'Invalid state': { key: 'error.setupDone' },
  'Invalid step': { key: 'error.setupStep' },
};

/**
 * Plain errors thrown by the services for invalid user input.
 * Without a mapping they become "500 Server Error".
 */
const SERVICE_ERRORS: Record<string, Required<ErrorDef>> = {
  'Invalid password': { key: 'error.invalidPassword', statusCode: 400 },
  'Invalid TOTP code': { key: 'error.invalidTotpCode', statusCode: 400 },
  'TOTP is already verified': {
    key: 'error.totpAlreadyEnabled',
    statusCode: 409,
  },
  'TOTP key is not set': { key: 'error.totpNotSetUp', statusCode: 400 },
  'User already exists': { key: 'error.userExists', statusCode: 409 },
  'Password login not enabled': {
    key: 'error.unlinkNoPassword',
    statusCode: 400,
  },
  'User already linked with an OAuth provider': {
    key: 'error.oauthUserLinked',
    statusCode: 409,
  },
  'OAuth account already linked with another user': {
    key: 'error.oauthIdentityTaken',
    statusCode: 409,
  },
  'IPv4 address is not within the CIDR range': {
    key: 'error.ipv4OutOfRange',
    statusCode: 400,
  },
  'IPv6 address is not within the CIDR range': {
    key: 'error.ipv6OutOfRange',
    statusCode: 400,
  },
  'Client not found': { key: 'error.clientNotFound', statusCode: 404 },
};

/** messages with a variable part */
const PATTERNS: {
  regex: RegExp;
  key: string;
  params: (m: RegExpMatchArray) => Params;
}[] = [
  {
    regex: /^Per-Client Firewall requires (.+?) to be installed/,
    key: 'error.firewallToolsMissing',
    params: (m) => ({ tools: m[1] ?? '' }),
  },
];

export type ErrorTranslation = {
  key: string;
  params?: Params;
  /** set for plain errors that get a proper status code */
  statusCode?: number;
};

/** translation key of a known error, null if unknown */
export function errorTranslationOf(err: unknown): ErrorTranslation | null {
  if (isError(err)) {
    const data = err.data as { key?: unknown } | undefined;
    if (data && typeof data.key === 'string') {
      // already translated (createI18nError)
      return { key: data.key };
    }
    const statusMessage = err.statusMessage ?? '';
    const def = HTTP_ERRORS[statusMessage];
    if (def) return { key: def.key };
    for (const p of PATTERNS) {
      const m = statusMessage.match(p.regex);
      if (m) return { key: p.key, params: p.params(m) };
    }
    return null;
  }
  if (err instanceof Error) {
    const def = SERVICE_ERRORS[err.message];
    if (def) return { key: def.key, statusCode: def.statusCode };
  }
  return null;
}

/** translated text, null if the key is unknown */
export async function translateKey(
  event: H3Event,
  key: string,
  params: Params = {}
): Promise<string | null> {
  try {
    const t = await useTranslation(event);
    if (!t) return null;
    const text = t(key, params);
    return typeof text === 'string' && text !== '' && text !== key
      ? text
      : null;
  } catch {
    return null;
  }
}

/**
 * Error with a translated message.
 * @param statusMessage English, also used when the key can't be translated
 */
export async function createI18nError(
  event: H3Event,
  opts: {
    statusCode: number;
    statusMessage: string;
    key: string;
    params?: Params;
    data?: Record<string, unknown>;
  }
) {
  const message =
    (await translateKey(event, opts.key, opts.params)) ?? opts.statusMessage;
  return createError({
    statusCode: opts.statusCode,
    statusMessage: opts.statusMessage,
    message,
    data: { ...opts.data, message, key: opts.key },
  });
}

/**
 * Translate a known error, unknown errors are returned unchanged
 */
export async function localizeError(event: H3Event, err: unknown) {
  const tr = errorTranslationOf(err);
  if (!tr) return err;

  if (isError(err)) {
    const data = err.data as { key?: unknown } | undefined;
    if (data && typeof data.key === 'string') return err;
    return createI18nError(event, {
      statusCode: err.statusCode,
      statusMessage: err.statusMessage ?? err.message,
      key: tr.key,
      params: tr.params,
      data:
        err.data && typeof err.data === 'object'
          ? (err.data as Record<string, unknown>)
          : undefined,
    });
  }

  // plain service error: user error instead of "500 Server Error"
  return createI18nError(event, {
    statusCode: tr.statusCode ?? 400,
    statusMessage: (err as Error).message,
    key: tr.key,
    params: tr.params,
  });
}

/** wrap an event handler: known errors get a translated message */
export function withI18nErrors<T extends EventHandlerRequest, R>(
  handler: (event: H3Event<T>) => Promise<R>
) {
  return async (event: H3Event<T>): Promise<R> => {
    try {
      return await handler(event);
    } catch (err) {
      throw await localizeError(event, err);
    }
  };
}

/**
 * OAuth browser flows (login / link) can't show a JSON error: redirect back
 * to the page with the translation key, the page shows it as a toast.
 */
export function oauthErrorRedirect(
  event: H3Event,
  err: unknown,
  target: '/login' | '/me'
) {
  const tr = errorTranslationOf(err);
  if (!tr) {
    console.error('OAuth flow failed:', err);
  }
  const key = tr?.key ?? 'error.oauthFailed';
  return sendRedirect(
    event,
    `${target}?oauth_error=${encodeURIComponent(key)}`
  );
}
