CREATE TABLE `employee_pay_rates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`rate` real DEFAULT 0 NOT NULL,
	`effective_from` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_pay_rate_user_date` ON `employee_pay_rates` (`user_id`,`effective_from`);--> statement-breakpoint
INSERT OR IGNORE INTO `employee_pay_rates` (`user_id`, `rate`, `effective_from`, `created_at`)
SELECT `id`, `hourly_rate`, substr(`created_at`, 1, 10), `created_at`
FROM `users`
WHERE `role` = 'employee';
