CREATE TABLE `im_message_tombstone` (
	`id` text PRIMARY KEY,
	`platform` text NOT NULL,
	`channel_name` text NOT NULL,
	`event_id` text NOT NULL,
	`ingest_seq` integer NOT NULL,
	`payload_hash` text NOT NULL,
	`legacy_status` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `im_outbound_tombstone` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`platform` text NOT NULL,
	`channel_name` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`provider_message_id` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `im_outbound_tombstone_project_id_id_pk` PRIMARY KEY(`project_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `im_message_tombstone_channel_event_idx` ON `im_message_tombstone` (`channel_name`,`event_id`);