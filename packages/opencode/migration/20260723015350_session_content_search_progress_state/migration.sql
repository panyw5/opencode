ALTER TABLE `session_content_search_progress` ADD `enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_content_search_progress` ADD `state` text DEFAULT 'paused' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_content_search_progress` ADD `generation` integer DEFAULT 0 NOT NULL;