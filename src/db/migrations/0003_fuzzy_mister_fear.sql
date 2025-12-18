PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspace_invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by_id` text NOT NULL,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_workspace_invitation`("id", "workspace_id", "created_by_id", "email", "token", "expires_at") SELECT "id", "workspace_id", "created_by_id", "email", "token", "expires_at" FROM `workspace_invitation`;--> statement-breakpoint
DROP TABLE `workspace_invitation`;--> statement-breakpoint
ALTER TABLE `__new_workspace_invitation` RENAME TO `workspace_invitation`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitation_token_unique` ON `workspace_invitation` (`token`);--> statement-breakpoint
ALTER TABLE `label` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `issue` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `issue_attachment` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `issue_comment` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `team` ADD `deleted_at` integer;