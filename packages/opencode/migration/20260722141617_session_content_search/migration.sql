-- Custom SQL migration file, put your code below! --
CREATE VIRTUAL TABLE `session_content_fts` USING fts5(
	`part_id` UNINDEXED,
	`message_id` UNINDEXED,
	`session_id` UNINDEXED,
	`text`
);
