CREATE TABLE `session_input_cursor` (
	`session_id` text PRIMARY KEY,
	`next_admitted_seq` integer NOT NULL,
	`next_promoted_seq` integer NOT NULL,
	`consumed_seq` integer DEFAULT -1 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_input_cursor_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
