INSERT OR IGNORE INTO `project` (`id`, `worktree`, `visibility`, `sandboxes`, `time_created`, `time_updated`)
VALUES ('global', '', 'user', '[]', unixepoch('now') * 1000, unixepoch('now') * 1000);--> statement-breakpoint
CREATE TABLE `__new_im_outbound` (
  `id` text PRIMARY KEY,
  `project_id` text NOT NULL,
  `platform` text NOT NULL,
  `channel_name` text NOT NULL,
  `mode` text NOT NULL,
  `target` text NOT NULL,
  `provider_sequence` integer,
  `text` text NOT NULL,
  `status` text NOT NULL,
  `provider_message_id` text,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  CONSTRAINT `fk_im_outbound_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
INSERT INTO `__new_im_outbound`(`id`, `project_id`, `platform`, `channel_name`, `mode`, `target`, `provider_sequence`, `text`, `status`, `provider_message_id`, `attempt_count`, `last_error`, `time_created`, `time_updated`)
SELECT `id`, 'global', `platform`, `channel_name`, `mode`, `target`, NULL, `text`, `status`, `provider_message_id`, `attempt_count`, `last_error`, `time_created`, `time_updated`
FROM `im_outbound`;--> statement-breakpoint
DROP TABLE `im_outbound`;--> statement-breakpoint
ALTER TABLE `__new_im_outbound` RENAME TO `im_outbound`;--> statement-breakpoint
CREATE INDEX `im_outbound_channel_status_time_idx` ON `im_outbound` (`channel_name`,`status`,`time_created`);
