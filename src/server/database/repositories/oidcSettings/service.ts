import { eq } from 'drizzle-orm';

import { oidcSettings } from './schema';
import type { OidcSettingsUpdateType } from './types';

import type { DBType } from '#db/sqlite';

const ROW_ID = 1;

export class OidcSettingsService {
  #db: DBType;

  constructor(db: DBType) {
    this.#db = db;
  }

  /**
   * @returns the override row, or null if nothing was saved yet
   */
  async get() {
    const result = await this.#db.query.oidcSettings
      .findFirst({ where: eq(oidcSettings.id, ROW_ID) })
      .execute();
    return result ?? null;
  }

  /**
   * LiveWireGuard endpoint url handed to the app (setup QR code)
   * @param endpointUrl null = derive from the request host
   */
  async updateEndpointUrl(endpointUrl: string | null) {
    await this.#db
      .insert(oidcSettings)
      .values({ id: ROW_ID, endpointUrl })
      .onConflictDoUpdate({ target: oidcSettings.id, set: { endpointUrl } })
      .execute();
  }

  async update(data: OidcSettingsUpdateType) {
    // secrets: undefined means "keep the stored value"
    const values: Partial<typeof oidcSettings.$inferInsert> = {
      enabled: data.enabled,
      friendlyName: data.friendlyName,
      server: data.server,
      clientId: data.clientId,
      appClientId: data.appClientId,
      appScopes: data.appScopes,
      appRedirectUri: data.appRedirectUri,
      endpointUrl: data.endpointUrl,
    };
    if (data.clientSecret !== undefined) {
      values.clientSecret = data.clientSecret;
    }
    // role mapping: undefined means "keep the stored value"
    if (data.adminGroups !== undefined) {
      values.adminGroups = data.adminGroups;
    }
    if (data.groupsClaim !== undefined) {
      values.groupsClaim = data.groupsClaim;
    }
    if (data.panelScopes !== undefined) {
      values.panelScopes = data.panelScopes;
    }
    if (data.appClientSecret !== undefined) {
      values.appClientSecret = data.appClientSecret;
    }

    await this.#db
      .insert(oidcSettings)
      .values({ id: ROW_ID, ...values })
      .onConflictDoUpdate({ target: oidcSettings.id, set: values })
      .execute();
  }
}
