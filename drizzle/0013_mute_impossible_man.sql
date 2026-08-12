CREATE TABLE `bottleneck_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`project_id` text,
	`session_id` text,
	`detail` text,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `routed_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`target_session_id` text,
	`instruction` text NOT NULL,
	`tier` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text,
	`depends_on` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`enqueued_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `routing_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`classification_id` text NOT NULL,
	`layer` text NOT NULL,
	`chosen_agent_id` text,
	`chosen_session_id` text,
	`alternatives` text,
	`rationale` text NOT NULL,
	`score` real NOT NULL,
	`operator_override` text,
	`outcome` text,
	`outcome_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`classification_id`) REFERENCES `task_classifications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chosen_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chosen_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_classifications` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text,
	`session_id` text,
	`instruction` text NOT NULL,
	`category` text NOT NULL,
	`confidence` real NOT NULL,
	`classifier_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
