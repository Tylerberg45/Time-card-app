UPDATE `users`
SET
	`pin_hash` = 'P+CYslzmdi4S/tWTN8uUvqC2L7MJGz0kdkKQnAegUyk=',
	`pin_salt` = 'YPIbBlo0UZCa9gsalo+anQ=='
WHERE `id` = 1 AND `name` = 'Corbin' AND `role` = 'admin';
--> statement-breakpoint
DELETE FROM `sessions`
WHERE `user_id` = 1
	AND EXISTS (
		SELECT 1 FROM `users`
		WHERE `id` = 1 AND `name` = 'Corbin' AND `role` = 'admin'
	);
--> statement-breakpoint
INSERT INTO `audit_log` (
	`actor_id`, `actor_name`, `action`, `target_type`, `target_id`, `summary`, `details`, `created_at`
)
SELECT
	`id`, 'System', 'pin_reset', 'administrator', CAST(`id` AS TEXT),
	'Reset administrator PIN for Corbin', '{"pinChanged":true}',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `users`
WHERE `id` = 1 AND `name` = 'Corbin' AND `role` = 'admin';
