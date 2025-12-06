ALTER TABLE `issue_change_event` ADD `related_entity_id` text;--> statement-breakpoint
ALTER TABLE `issue_change_event` DROP COLUMN `metadata`;