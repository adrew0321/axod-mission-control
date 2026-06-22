CREATE TABLE `dream_insights` (
	`id` text PRIMARY KEY NOT NULL,
	`dream_id` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dream_id`) REFERENCES `dreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `dreams` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`covers_since` integer NOT NULL,
	`status` text NOT NULL,
	`insight_count` integer DEFAULT 0 NOT NULL,
	`error` text
);
