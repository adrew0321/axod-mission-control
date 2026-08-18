CREATE TABLE `room_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`zone` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`ext` text,
	`head` text,
	`summary` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
