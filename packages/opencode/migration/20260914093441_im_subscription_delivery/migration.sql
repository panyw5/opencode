CREATE TABLE `im_subscription_delivery` (
	`subscription_id` text NOT NULL,
	`message_id` text NOT NULL,
	`ingest_seq` integer NOT NULL,
	`status` text DEFAULT 'admitted' NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `im_subscription_delivery_pk` PRIMARY KEY(`subscription_id`, `message_id`),
	CONSTRAINT `fk_im_subscription_delivery_subscription_id_im_subscription_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `im_subscription`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `im_subscription_delivery_seq_idx` ON `im_subscription_delivery` (`subscription_id`,`ingest_seq`);