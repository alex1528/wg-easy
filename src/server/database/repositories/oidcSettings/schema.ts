import { sql } from 'drizzle-orm';
import { sqliteTable, text, int } from 'drizzle-orm/sqlite-core';

/**
 * Single row (id = 1) of OIDC overrides.
 * Every column is nullable: null means "fall back to the environment / default".
 */
export const oidcSettings = sqliteTable('oidc_settings_table', {
  id: int().primaryKey({ autoIncrement: false }).default(1),
  enabled: int('enabled', { mode: 'boolean' }),
  friendlyName: text('friendly_name'),
  server: text('server'),
  clientId: text('client_id'),
  clientSecret: text('client_secret'),
  appClientId: text('app_client_id'),
  appClientSecret: text('app_client_secret'),
  /** space separated */
  appScopes: text('app_scopes'),
  appRedirectUri: text('app_redirect_uri'),
  endpointUrl: text('endpoint_url'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`),
});
