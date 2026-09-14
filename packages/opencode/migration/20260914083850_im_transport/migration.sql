CREATE TABLE `im_message` (
	`id` text PRIMARY KEY,
	`platform` text NOT NULL,
	`channel_name` text NOT NULL,
	`event_id` text NOT NULL,
	`direction` text NOT NULL,
	`scope` text NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text,
	`sender_name` text,
	`reply_to` text,
	`text` text NOT NULL,
	`time_event` integer,
	`metadata` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `im_outbound` (
	`id` text PRIMARY KEY,
	`platform` text NOT NULL,
	`channel_name` text NOT NULL,
	`mode` text NOT NULL,
	`target` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`provider_message_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_message_channel_event_idx` ON `im_message` (`channel_name`,`event_id`);--> statement-breakpoint
CREATE INDEX `im_message_channel_conversation_time_idx` ON `im_message` (`channel_name`,`conversation_id`,`time_created`,`id`);--> statement-breakpoint
CREATE INDEX `im_message_time_created_id_idx` ON `im_message` (`time_created`,`id`);--> statement-breakpoint
CREATE INDEX `im_outbound_channel_status_time_idx` ON `im_outbound` (`channel_name`,`status`,`time_created`);