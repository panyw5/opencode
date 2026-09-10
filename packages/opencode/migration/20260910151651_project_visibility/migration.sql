ALTER TABLE `project` ADD `visibility` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `project_kind` text;--> statement-breakpoint
UPDATE `project` AS `p`
SET `visibility` = 'internal', `project_kind` = 'math'
WHERE `p`.`worktree` LIKE '%/.math/problems/%'
  AND `p`.`name` IS NULL
  AND `p`.`icon_url` IS NULL
  AND `p`.`icon_url_override` IS NULL
  AND `p`.`icon_color` IS NULL
  AND `p`.`time_initialized` IS NULL
  AND EXISTS (
    SELECT 1 FROM `session` AS `s`
    WHERE `s`.`project_id` = `p`.`id` AND `s`.`agent` = 'math-verifier'
  )
  AND NOT EXISTS (
    SELECT 1 FROM `session` AS `s`
    WHERE `s`.`project_id` = `p`.`id`
      AND (`s`.`agent` IS NULL OR `s`.`agent` NOT IN ('math-worker', 'math-verifier'))
  )
  AND NOT EXISTS (SELECT 1 FROM `workspace` AS `w` WHERE `w`.`project_id` = `p`.`id`)
  AND NOT EXISTS (SELECT 1 FROM `scheduled_task` AS `t` WHERE `t`.`project_id` = `p`.`id`);
