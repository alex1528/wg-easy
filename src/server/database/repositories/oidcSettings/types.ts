import type { InferSelectModel } from 'drizzle-orm';
import z from 'zod';

import type { oidcSettings } from './schema';

import { controlStringRefine, safeStringRefine, t } from '#server/utils/types';
import { normalizeList, splitScopes } from '#server/utils/oidcSettings';

export type OidcSettingsType = InferSelectModel<typeof oidcSettings>;

/** empty / whitespace-only strings are treated as "not set" (null) */
function emptyToNull(v: unknown) {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  }
  return v;
}

const optionalText = (message: string) =>
  z.preprocess(
    emptyToNull,
    z
      .string({ message })
      .max(1024, { message })
      .pipe(safeStringRefine)
      .pipe(controlStringRefine)
      .nullable()
  );

const optionalUrl = (message: string) =>
  z.preprocess(
    emptyToNull,
    z
      .string({ message })
      .max(2048, { message })
      .refine((v) => isAbsoluteUrl(v), { message })
      .nullable()
  );

/**
 * secrets: undefined = keep, null / "" = clear (fall back to env), string = set
 */
const optionalSecret = (message: string) =>
  z.preprocess(
    emptyToNull,
    z
      .string({ message })
      .max(4096, { message })
      .pipe(controlStringRefine)
      .nullable()
      .optional()
  );

function isAbsoluteUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol.length > 1 && url.host.length > 0;
  } catch {
    return false;
  }
}

/** custom-scheme redirect uris like `com.example.app:/oidc/callback` */
function isRedirectUri(value: string) {
  try {
    const url = new URL(value);
    return url.protocol.length > 1;
  } catch {
    return false;
  }
}

const scopes = z.preprocess(
  emptyToNull,
  z
    .string({ message: t('zod.oidc.scopes') })
    .max(1024, { message: t('zod.oidc.scopes') })
    .pipe(controlStringRefine)
    .refine((v) => splitScopes(v).includes('openid'), {
      message: t('zod.oidc.scopesOpenid'),
    })
    .transform((v) => splitScopes(v).join(' '))
    .nullable()
);

const redirectUri = z.preprocess(
  emptyToNull,
  z
    .string({ message: t('zod.oidc.redirectUri') })
    .max(2048, { message: t('zod.oidc.redirectUri') })
    .refine((v) => isRedirectUri(v), { message: t('zod.oidc.redirectUri') })
    .nullable()
);

/** undefined = keep, null / [] = fall back to env */
const adminGroups = z
  .array(
    z
      .string({ message: t('zod.oidc.adminGroups') })
      .max(256, { message: t('zod.oidc.adminGroups') })
      .pipe(controlStringRefine),
    { message: t('zod.oidc.adminGroups') }
  )
  .max(50, { message: t('zod.oidc.adminGroups') })
  .transform((v) => {
    const groups = normalizeList(v);
    return groups.length === 0 ? null : groups;
  })
  .nullable()
  .optional();

const groupsClaim = z.preprocess(
  emptyToNull,
  z
    .string({ message: t('zod.oidc.groupsClaim') })
    .max(256, { message: t('zod.oidc.groupsClaim') })
    .regex(/^\S+$/, { message: t('zod.oidc.groupsClaim') })
    .pipe(controlStringRefine)
    .pipe(safeStringRefine)
    .nullable()
    .optional()
);

const panelScopes = z.preprocess(
  emptyToNull,
  z
    .string({ message: t('zod.oidc.panelScopes') })
    .max(1024, { message: t('zod.oidc.panelScopes') })
    .pipe(controlStringRefine)
    .refine((v) => splitScopes(v).includes('openid'), {
      message: t('zod.oidc.scopesOpenid'),
    })
    .transform((v) => normalizeList(splitScopes(v)).join(' '))
    .nullable()
    .optional()
);

export const OidcSettingsUpdateSchema = z.object({
  enabled: z.boolean({ message: t('zod.oidc.enabled') }).nullable(),
  friendlyName: optionalText(t('zod.oidc.friendlyName')),
  server: optionalUrl(t('zod.oidc.server')),
  clientId: optionalText(t('zod.oidc.clientId')),
  clientSecret: optionalSecret(t('zod.oidc.clientSecret')),
  appClientId: optionalText(t('zod.oidc.appClientId')),
  appClientSecret: optionalSecret(t('zod.oidc.appClientSecret')),
  appScopes: scopes,
  appRedirectUri: redirectUri,
  endpointUrl: optionalUrl(t('zod.oidc.endpointUrl')),
  adminGroups: adminGroups,
  groupsClaim: groupsClaim,
  panelScopes: panelScopes,
});

export type OidcSettingsUpdateType = z.infer<typeof OidcSettingsUpdateSchema>;
