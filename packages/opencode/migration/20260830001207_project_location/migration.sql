CREATE TABLE `project_location` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`directory` text NOT NULL,
	`canonical_directory` text NOT NULL,
	`kind` text NOT NULL,
	`vcs_type` text,
	`vcs_state` text NOT NULL,
	`worktree_root` text,
	`git_common_dir` text,
	`marker` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_last_seen` integer NOT NULL,
	CONSTRAINT `fk_project_location_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `project_alias` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`confidence` text NOT NULL,
	`source_location_id` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_last_seen` integer NOT NULL,
	CONSTRAINT `fk_project_alias_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_project_alias_source_location_id_project_location_id_fk` FOREIGN KEY (`source_location_id`) REFERENCES `project_location`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `workspace` ADD `location_id` text REFERENCES project_location(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `scheduled_task` ADD `location_id` text REFERENCES project_location(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `location_id` text REFERENCES project_location(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `workspace_location_idx` ON `workspace` (`location_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_alias_project_kind_value_idx` ON `project_alias` (`project_id`,`kind`,`value`);--> statement-breakpoint
CREATE INDEX `project_alias_kind_value_idx` ON `project_alias` (`kind`,`value`);--> statement-breakpoint
CREATE INDEX `project_alias_project_idx` ON `project_alias` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_alias_source_location_idx` ON `project_alias` (`source_location_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_location_canonical_directory_idx` ON `project_location` (`canonical_directory`);--> statement-breakpoint
CREATE INDEX `project_location_project_idx` ON `project_location` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_location_git_common_dir_idx` ON `project_location` (`git_common_dir`);--> statement-breakpoint
CREATE INDEX `scheduled_task_location_idx` ON `scheduled_task` (`location_id`);--> statement-breakpoint
CREATE INDEX `session_location_idx` ON `session` (`location_id`);
