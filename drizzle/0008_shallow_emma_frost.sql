CREATE TABLE `login_attempts` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`window_started_at` text NOT NULL,
	`locked_until` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `pay_weeks` ADD `received` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pay_weeks` ADD `payment_date` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `pay_weeks` ADD `payment_method` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `active` integer DEFAULT true NOT NULL;