PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issue` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`workspace_id` text NOT NULL,
	`team_id` text NOT NULL,
	`created_by_id` text NOT NULL,
	`assigned_to_id` text,
	`key_number` integer NOT NULL,
	`summary` text NOT NULL,
	`status` text DEFAULT 'to_do' NOT NULL,
	`description` text NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_to_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_issue`("id", "key", "workspace_id", "team_id", "created_by_id", "assigned_to_id", "key_number", "summary", "status", "description", "order", "priority", "created_at", "updated_at") SELECT "id", "key", "workspace_id", "team_id", "created_by_id", "assigned_to_id", "key_number", "summary", "status", "description", "order", "priority", "created_at", "updated_at" FROM `issue`;--> statement-breakpoint
DROP TABLE `issue`;--> statement-breakpoint
ALTER TABLE `__new_issue` RENAME TO `issue`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_key_workspace_id_unique` ON `issue` (`key`,`workspace_id`);--> statement-breakpoint
ALTER TABLE `workspace_invitation` ADD `email` text DEFAULT '' NOT NULL;