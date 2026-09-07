ALTER TABLE `session` ADD `time_favorited` integer;--> statement-breakpoint
CREATE INDEX `session_time_favorited_idx` ON `session` (`time_favorited`);