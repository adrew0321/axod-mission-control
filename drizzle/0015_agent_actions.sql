CREATE TABLE `agent_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`target` text NOT NULL,
	`event` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text,
	`exit_code` integer,
	`status` text,
	`reason` text,
	`posted_at` integer
);
