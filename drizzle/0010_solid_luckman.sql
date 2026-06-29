PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`title` text,
	`branch` text,
	`base_branch` text,
	`worktree_path` text,
	`status` text NOT NULL,
	`cleared_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`running_since` integer,
	`archived_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "project_id", "title", "branch", "base_branch", "worktree_path", "status", "cleared_at", "created_at", "updated_at", "running_since", "archived_at") SELECT "id", "project_id", "title", "branch", "base_branch", "worktree_path", "status", "cleared_at", "created_at", "updated_at", "running_since", "archived_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;