CREATE TABLE `session_instruction_snapshot` (
	`source` text NOT NULL,
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`hash` text NOT NULL,
	`snapshot` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	CONSTRAINT `session_instruction_snapshot_pk` PRIMARY KEY(`source`, `message_id`),
	CONSTRAINT `fk_session_instruction_snapshot_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_instruction_snapshot_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_instruction_snapshot_session_idx` ON `session_instruction_snapshot` (`session_id`);