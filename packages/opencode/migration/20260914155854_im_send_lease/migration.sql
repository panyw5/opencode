ALTER TABLE `im_outbound` ADD `lease_expires_at` integer;--> statement-breakpoint
CREATE INDEX `im_outbound_status_lease_idx` ON `im_outbound` (`status`,`lease_expires_at`);