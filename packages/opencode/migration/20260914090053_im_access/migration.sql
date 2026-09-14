CREATE TABLE `im_access` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`platform` text NOT NULL,
	`channel_name` text NOT NULL,
	`scope` text NOT NULL,
	`conversation_id` text NOT NULL,
	`can_read` integer DEFAULT false NOT NULL,
	`can_send` integer DEFAULT false NOT NULL,
	`can_watch` integer DEFAULT false NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_im_access_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_access_project_target_idx` ON `im_access` (`project_id`,`platform`,`channel_name`,`scope`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `im_access_project_read_idx` ON `im_access` (`project_id`,`can_read`);