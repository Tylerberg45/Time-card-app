CREATE TABLE `job_mismatch_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`user_a_id` integer NOT NULL,
	`user_b_id` integer NOT NULL,
	`job_a_id` integer NOT NULL,
	`job_b_id` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`dates` text DEFAULT '[]' NOT NULL,
	`entry_ids_a` text DEFAULT '[]' NOT NULL,
	`entry_ids_b` text DEFAULT '[]' NOT NULL,
	`hours_a` real DEFAULT 0 NOT NULL,
	`hours_b` real DEFAULT 0 NOT NULL,
	`confidence` text DEFAULT 'possible' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by` integer,
	`reviewed_at` text,
	`selected_job_id` integer,
	`notification_id` text,
	`notification_sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_a_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_b_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_a_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_b_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`selected_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_mismatch_fingerprint` ON `job_mismatch_reviews` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `job_mismatch_status_start` ON `job_mismatch_reviews` (`status`,`start_date`);