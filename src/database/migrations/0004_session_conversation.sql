PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`proposal_version` integer NOT NULL,
	`decision` text NOT NULL,
	`github_user` text NOT NULL,
	`github_user_id` integer NOT NULL,
	`source` text DEFAULT 'github' NOT NULL,
	`github_comment_id` integer,
	`session_message_id` text,
	`instructions` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "decisions_decision_ck" CHECK(decision in ('approve', 'reject', 'revise'))
);
--> statement-breakpoint
INSERT INTO `__new_decisions`("id", "task_id", "proposal_version", "decision", "github_user", "github_user_id", "source", "github_comment_id", "session_message_id", "instructions", "created_at") SELECT "id", "task_id", "proposal_version", "decision", "github_user", "github_user_id", 'github', "github_comment_id", NULL, "instructions", "created_at" FROM `decisions`;--> statement-breakpoint
DROP TABLE `decisions`;--> statement-breakpoint
ALTER TABLE `__new_decisions` RENAME TO `decisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_comment_uq` ON `decisions` (`github_comment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_session_message_uq` ON `decisions` (`session_message_id`);--> statement-breakpoint
CREATE INDEX `decisions_task_idx` ON `decisions` (`task_id`,`proposal_version`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `session_cursor` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `input_notified_at` integer;