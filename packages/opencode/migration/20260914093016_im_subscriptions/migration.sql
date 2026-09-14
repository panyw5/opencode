CREATE TABLE `im_subscription` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`platform` text NOT NULL,
	`channel_name` text NOT NULL,
	`scope` text NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text,
	`keyword` text,
	`status` text DEFAULT 'active' NOT NULL,
	`failure_reason` text,
	`delivery_cursor` integer DEFAULT -1 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_im_subscription_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_im_subscription_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `im_subscription_project_status_idx` ON `im_subscription` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `im_subscription_target_status_idx` ON `im_subscription` (`platform`,`channel_name`,`scope`,`conversation_id`,`status`);