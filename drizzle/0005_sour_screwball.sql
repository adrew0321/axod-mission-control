CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`instruction` text NOT NULL,
	`cadence_kind` text NOT NULL,
	`interval_hours` integer,
	`time_of_day` text,
	`day_of_week` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`last_session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
