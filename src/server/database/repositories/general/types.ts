import type { InferSelectModel } from 'drizzle-orm';
import z from 'zod';

import type { general } from './schema';

import { safeStringRefine, t } from '#server/utils/types';

export type GeneralType = InferSelectModel<typeof general>;

const sessionTimeout = z.number({ message: t('zod.general.sessionTimeout') });

const metricsEnabled = z.boolean({ message: t('zod.general.metricsEnabled') });

const metricsPassword = z
  .string({ message: t('zod.general.metricsPassword') })
  .min(1, { message: t('zod.general.metricsPassword') })
  .pipe(safeStringRefine)
  .nullable();

const liveWireGuardEnabled = z.boolean({
  message: t('zod.general.liveWireGuardEnabled'),
});

const liveWireGuardAudience = z
  .string({ message: t('zod.general.liveWireGuardAudience') })
  .min(1, { message: t('zod.general.liveWireGuardAudience') })
  .pipe(safeStringRefine);

export const GeneralUpdateSchema = z.object({
  sessionTimeout: sessionTimeout,
  metricsPrometheus: metricsEnabled,
  metricsJson: metricsEnabled,
  metricsPassword: metricsPassword,
  liveWireGuardEnabled: liveWireGuardEnabled,
  liveWireGuardAudience: liveWireGuardAudience,
});

export type GeneralUpdateType = z.infer<typeof GeneralUpdateSchema>;

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.host.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * LiveWireGuard endpoint url (stored with the OIDC settings).
 * undefined = keep, null / "" = derive from the request host
 */
const liveWireGuardEndpointUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z
    .string({ message: t('zod.general.liveWireGuardEndpointUrl') })
    .trim()
    .max(2048, { message: t('zod.general.liveWireGuardEndpointUrl') })
    .refine(isHttpUrl, { message: t('zod.general.liveWireGuardEndpointUrl') })
    .nullable()
    .optional()
);

/** body of POST /api/admin/general */
export const GeneralUpdateRequestSchema = GeneralUpdateSchema.extend({
  liveWireGuardEndpointUrl: liveWireGuardEndpointUrl,
});

export type SetupStepType = { step: number; done: boolean };
