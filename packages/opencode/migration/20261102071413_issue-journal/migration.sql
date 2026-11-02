CREATE TABLE `issue_occurrence` (
	`id` text PRIMARY KEY,
	`issue_id` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_issue_occurrence_issue_id_issue_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `issue` (
	`id` text PRIMARY KEY,
	`directory` text NOT NULL,
	`session_id` text,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issue_occurrence_issue_idx` ON `issue_occurrence` (`issue_id`,`id`);--> statement-breakpoint
CREATE INDEX `issue_directory_time_idx` ON `issue` (`directory`,`time_updated`,`id`);--> statement-breakpoint
CREATE INDEX `issue_session_idx` ON `issue` (`session_id`);