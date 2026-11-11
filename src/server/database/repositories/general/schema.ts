import { sql } from 'drizzle-orm';
import { sqliteTable, text, int } from 'drizzle-orm/sqlite-core';

export const general = sqliteTable('general_table', {
  id: int().primaryKey({ autoIncrement: false }).default(1),

  setupStep: int('setup_step').notNull(),

  sessionPassword: text('session_password').notNull(),
  sessionTimeout: int('session_timeout').notNull(),

  metricsPrometheus: int('metrics_prometheus', { mode: 'boolean' }).notNull(),
  metricsJson: int('metrics_json', { mode: 'boolean' }).notNull(),
  metricsPassword: text('metrics_password'),

  /**
   * enabled on new installations by migration 0015 (the column default is
   * false since 0010, existing installations keep their value)
   */
  liveWireGuardEnabled: int('livewireguard_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  liveWireGuardAudience: text('livewireguard_audience')
    .notNull()
    .default('livewireguard'),

  /** max clients a non admin user can create themselves, 0 = unlimited */
  maxClientsPerUser: int('max_clients_per_user').notNull().default(5),

  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`),
});
