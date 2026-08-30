CREATE TABLE `permission_scope` (
	`id` text PRIMARY KEY,
	`scope` text NOT NULL,
	`project_id` text,
	`location_id` text,
	`data` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_permission_scope_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_permission_scope_location_id_project_location_id_fk` FOREIGN KEY (`location_id`) REFERENCES `project_location`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `permission_scope_project_idx` ON `permission_scope` (`project_id`);--> statement-breakpoint
CREATE INDEX `permission_scope_location_idx` ON `permission_scope` (`location_id`);