ALTER TABLE `im_subscription` ADD `start_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing subscriptions predate the creation checkpoint. Start them at the
-- current durable high-water mark rather than replaying the entire inbox.
UPDATE `im_subscription`
SET `start_seq` = coalesce((SELECT max(`ingest_seq`) FROM `im_message`), -1)
WHERE `start_seq` = 0;
