-- Product default flipped: inject mounted project-task context on each turn.
-- Flip existing sessions so the checkbox appears checked (users can still opt out).
UPDATE `session` SET `inject_task_context` = 1;
