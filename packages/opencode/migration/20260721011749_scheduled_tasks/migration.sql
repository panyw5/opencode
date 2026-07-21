CREATE TABLE `scheduled_task` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`project_name` text,
	`directory` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`schedule_kind` text NOT NULL,
	`schedule_value` text NOT NULL,
	`schedule_timezone` text,
	`execution_mode` text NOT NULL,
	`session_id` text,
	`agent` text NOT NULL,
	`model` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`unattended` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_status` text,
	`last_error` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_scheduled_task_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_scheduled_task_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `scheduled_task_run` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`status` text NOT NULL,
	`owner_id` text,
	`lease_until` integer,
	`attempt` integer DEFAULT 0 NOT NULL,
	`session_id` text,
	`error` text,
	`time_created` integer NOT NULL,
	`time_started` integer,
	`time_finished` integer,
	CONSTRAINT `fk_scheduled_task_run_task_id_scheduled_task_id_fk` FOREIGN KEY (`task_id`) REFERENCES `scheduled_task`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_scheduled_task_run_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_task_run_occurrence_idx` ON `scheduled_task_run` (`task_id`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `scheduled_task_run_task_time_idx` ON `scheduled_task_run` (`task_id`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `scheduled_task_run_active_idx` ON `scheduled_task_run` (`task_id`,`status`,`lease_until`);--> statement-breakpoint
CREATE INDEX `scheduled_task_project_idx` ON `scheduled_task` (`project_id`);--> statement-breakpoint
CREATE INDEX `scheduled_task_next_run_idx` ON `scheduled_task` (`enabled`,`next_run_at`);
