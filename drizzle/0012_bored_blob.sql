ALTER TABLE `agents` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `max_turns` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `max_budget_usd` real;--> statement-breakpoint
ALTER TABLE `messages` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `cache_creation_tokens` integer;