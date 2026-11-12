ALTER TABLE `users_table` ADD `role_source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `users_table` ADD `oidc_groups` text;--> statement-breakpoint
ALTER TABLE `users_table` ADD `last_login_at` text;--> statement-breakpoint
UPDATE `users_table` SET `role_source` = 'oidc' WHERE `oauth_provider` = 'oidc' AND `password` IS NULL;--> statement-breakpoint
ALTER TABLE `oidc_settings_table` ADD `admin_groups` text;--> statement-breakpoint
ALTER TABLE `oidc_settings_table` ADD `groups_claim` text;--> statement-breakpoint
ALTER TABLE `oidc_settings_table` ADD `panel_scopes` text;