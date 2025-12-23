PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issue_attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text,
	`created_by_id` text NOT NULL,
	`file_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`original_file_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_issue_attachment`("id", "issue_id", "created_by_id", "file_path", "mime_type", "original_file_name", "created_at", "updated_at", "deleted_at") SELECT "id", "issue_id", "created_by_id", "file_path", "mime_type", "original_file_name", "created_at", "updated_at", "deleted_at" FROM `issue_attachment`;--> statement-breakpoint
DROP TABLE `issue_attachment`;--> statement-breakpoint
ALTER TABLE `__new_issue_attachment` RENAME TO `issue_attachment`;--> statement-breakpoint
PRAGMA foreign_keys=ON;