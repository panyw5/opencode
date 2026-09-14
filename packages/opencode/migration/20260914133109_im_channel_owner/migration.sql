CREATE TABLE `im_owner` (
	`channel_name` text PRIMARY KEY,
	`app_identity` text NOT NULL,
	`platform` text NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`name` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
