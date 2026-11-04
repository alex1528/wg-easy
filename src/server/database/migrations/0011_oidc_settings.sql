CREATE TABLE `oidc_settings_table` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer,
	`friendly_name` text,
	`server` text,
	`client_id` text,
	`client_secret` text,
	`app_client_id` text,
	`app_client_secret` text,
	`app_scopes` text,
	`app_redirect_uri` text,
	`endpoint_url` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
