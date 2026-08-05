CREATE TABLE `project_task` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text,
	`time_archived` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_task_project_idx` ON `project_task` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_task_project_status_updated_idx` ON `project_task` (`project_id`,`status`,`time_updated`);--> statement-breakpoint
CREATE INDEX `project_task_project_archived_updated_idx` ON `project_task` (`project_id`,`time_archived`,`time_updated`);--> statement-breakpoint
ALTER TABLE `session` ADD `mounted_task_id` text REFERENCES `project_task`(`id`) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `session_mounted_task_idx` ON `session` (`mounted_task_id`);
