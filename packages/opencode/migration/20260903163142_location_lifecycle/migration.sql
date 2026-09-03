ALTER TABLE `project_location` ADD `lifecycle_state` text DEFAULT 'available' NOT NULL;--> statement-breakpoint
ALTER TABLE `project_location` ADD `lifecycle_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `project_location` ADD `delete_operation_id` text;--> statement-breakpoint
ALTER TABLE `project_location` ADD `time_unavailable` integer;--> statement-breakpoint
ALTER TABLE `project_location` ADD `time_deleted` integer;--> statement-breakpoint
CREATE INDEX `project_location_lifecycle_state_idx` ON `project_location` (`lifecycle_state`);