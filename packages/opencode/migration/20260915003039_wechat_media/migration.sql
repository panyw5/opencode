CREATE TABLE `im_attachment` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`filename` text,
	`size` integer NOT NULL,
	`sha256` text,
	`status` text NOT NULL,
	`reason` text,
	`data` blob,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_im_attachment_message_id_im_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `im_message`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_attachment_message_ordinal_idx` ON `im_attachment` (`message_id`,`ordinal`);