CREATE TABLE `math_problem` (
	`parent_session_id` text NOT NULL,
	`problem_id` text NOT NULL,
	`owner_project_id` text NOT NULL,
	`owner_location_id` text,
	`orchestrator_session_id` text NOT NULL,
	`legacy` integer DEFAULT false NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `math_problem_pk` PRIMARY KEY(`parent_session_id`, `problem_id`),
	CONSTRAINT `fk_math_problem_parent_session_id_session_id_fk` FOREIGN KEY (`parent_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_math_problem_orchestrator_session_id_session_id_fk` FOREIGN KEY (`orchestrator_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_math_problem_owner_project_id_project_id_fk` FOREIGN KEY (`owner_project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_math_problem_owner_location_id_project_location_id_fk` FOREIGN KEY (`owner_location_id`) REFERENCES `project_location`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `math_problem_worker` (
	`parent_session_id` text NOT NULL,
	`problem_id` text NOT NULL,
	`worker_session_id` text NOT NULL,
	CONSTRAINT `math_problem_worker_pk` PRIMARY KEY(`parent_session_id`, `problem_id`, `worker_session_id`),
	CONSTRAINT `fk_math_problem_worker_parent_session_id_problem_id_math_problem_parent_session_id_problem_id_fk` FOREIGN KEY (`parent_session_id`,`problem_id`) REFERENCES `math_problem`(`parent_session_id`,`problem_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_math_problem_worker_worker_session_id_session_id_fk` FOREIGN KEY (`worker_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `math_problem_owner_idx` ON `math_problem` (`owner_project_id`,`owner_location_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `math_problem_worker_session_idx` ON `math_problem_worker` (`worker_session_id`);