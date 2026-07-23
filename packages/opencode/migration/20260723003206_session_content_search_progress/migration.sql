CREATE TABLE `session_content_search_progress` (
	`id` integer PRIMARY KEY,
	`indexed` integer NOT NULL,
	`total` integer NOT NULL,
	`cursor` text,
	`complete` integer NOT NULL
);
