ALTER TABLE `clients_table` ADD `device_id` text;--> statement-breakpoint
ALTER TABLE `general_table` ADD `livewireguard_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `general_table` ADD `livewireguard_audience` text DEFAULT 'livewireguard' NOT NULL;