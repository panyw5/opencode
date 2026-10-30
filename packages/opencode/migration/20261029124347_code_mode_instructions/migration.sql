CREATE TABLE `code_mode_instruction` (
	`message_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`hash` text NOT NULL,
	`snapshot` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	CONSTRAINT `fk_code_mode_instruction_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_code_mode_instruction_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `code_mode_instruction_session_idx` ON `code_mode_instruction` (`session_id`);