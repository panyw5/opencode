ALTER TABLE `im_outbound` ADD `provider_sequence_key` text;--> statement-breakpoint
UPDATE `im_outbound`
SET `provider_sequence_key` = `platform` || char(0) || `channel_name` || char(0) ||
  json_extract(`target`, '$.scope') || char(0) || json_extract(`target`, '$.conversationID')
  || char(0) || CASE WHEN `mode` = 'reply' THEN coalesce(json_extract(`target`, '$.replyTo'), '') ELSE 'proactive' END
WHERE `platform` = 'qq' AND `provider_sequence_key` IS NULL;--> statement-breakpoint
WITH ranked AS (
  SELECT rowid AS rid, row_number() OVER (
    PARTITION BY `provider_sequence_key` ORDER BY `time_created`, `id`
  ) AS seq
  FROM `im_outbound`
  WHERE `platform` = 'qq' AND `provider_sequence` IS NULL AND `provider_sequence_key` IS NOT NULL
)
UPDATE `im_outbound`
SET `provider_sequence` = (SELECT `seq` FROM ranked WHERE ranked.rid = `im_outbound`.rowid)
WHERE rowid IN (SELECT rid FROM ranked);
