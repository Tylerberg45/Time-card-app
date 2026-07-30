CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer,
	`actor_name` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text DEFAULT '' NOT NULL,
	`summary` text NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
