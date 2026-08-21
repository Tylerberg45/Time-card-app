CREATE TABLE `time_off_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by` integer,
	`review_note` text DEFAULT '' NOT NULL,
	`requested_at` text NOT NULL,
	`reviewed_at` text,
	`updated_at` text NOT NULL,
	`reminder_notification_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `time_off_user_dates` ON `time_off_requests` (`user_id`,`start_date`,`end_date`);--> statement-breakpoint
CREATE INDEX `time_off_status_start` ON `time_off_requests` (`status`,`start_date`);