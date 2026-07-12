CREATE TABLE `reflections` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`status` text NOT NULL,
	`lessons_before` integer DEFAULT 0 NOT NULL,
	`lessons_after` integer DEFAULT 0 NOT NULL,
	`soul_proposed` integer DEFAULT 0 NOT NULL,
	`error` text
);
