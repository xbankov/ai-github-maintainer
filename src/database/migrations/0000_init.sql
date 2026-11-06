CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` text,
	`task_id` integer,
	`action` text NOT NULL,
	`actor` text DEFAULT 'system' NOT NULL,
	`details` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_task_idx` ON `audit_log` (`task_id`);--> statement-breakpoint
CREATE INDEX `audit_log_repo_idx` ON `audit_log` (`repository_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`proposal_version` integer NOT NULL,
	`decision` text NOT NULL,
	`github_user` text NOT NULL,
	`github_user_id` integer NOT NULL,
	`github_comment_id` integer NOT NULL,
	`instructions` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "decisions_decision_ck" CHECK(decision in ('approve', 'reject', 'revise'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_comment_uq` ON `decisions` (`github_comment_id`);--> statement-breakpoint
CREATE INDEX `decisions_task_idx` ON `decisions` (`task_id`,`proposal_version`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_delivery_id` text NOT NULL,
	`event_type` text NOT NULL,
	`action` text,
	`repository_full_name` text,
	`payload` text NOT NULL,
	`processed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_delivery_uq` ON `events` (`github_delivery_id`);--> statement-breakpoint
CREATE INDEX `events_unprocessed_idx` ON `events` (`processed_at`);--> statement-breakpoint
CREATE TABLE `feature_fingerprints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`github_issue_number` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feature_fingerprints_repo_fp_uq` ON `feature_fingerprints` (`repository_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`available_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`locked_at` integer,
	`locked_by` text,
	`dedupe_key` text,
	`repository_id` text,
	`last_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "jobs_status_ck" CHECK(status in ('pending', 'running', 'succeeded', 'failed', 'dead')),
	CONSTRAINT "jobs_attempts_ck" CHECK("jobs"."attempts" >= 0 and "jobs"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`available_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_uq` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `locks` (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`github_comment_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "proposals_version_ck" CHECK("proposals"."version" >= 1),
	CONSTRAINT "proposals_status_ck" CHECK(status in ('pending', 'approved', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposals_task_version_uq` ON `proposals` (`task_id`,`version`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_discovery_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_owner_name_uq` ON `repositories` (lower("owner"),lower("name"));--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repository_id` text NOT NULL,
	`type` text NOT NULL,
	`github_issue_number` integer NOT NULL,
	`github_pr_number` integer,
	`status` text DEFAULT 'DISCOVERED' NOT NULL,
	`proposal_version` integer DEFAULT 0 NOT NULL,
	`approved_version` integer,
	`opencode_session_id` text,
	`branch_name` text,
	`iteration_count` integer DEFAULT 0 NOT NULL,
	`issue_fingerprint` text,
	`last_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tasks_status_ck" CHECK(status in ('DISCOVERED', 'ANALYZING', 'AWAITING_APPROVAL', 'REJECTED', 'APPROVED', 'IMPLEMENTING', 'TESTING', 'PR_OPEN', 'CHANGES_REQUESTED', 'READY_FOR_HUMAN_MERGE', 'COMPLETED', 'ABANDONED', 'FAILED')),
	CONSTRAINT "tasks_type_ck" CHECK(type in ('issue', 'feature')),
	CONSTRAINT "tasks_approved_version_ck" CHECK("tasks"."approved_version" is null or ("tasks"."approved_version" >= 1 and "tasks"."approved_version" <= "tasks"."proposal_version"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_active_issue_uq` ON `tasks` (`repository_id`,`github_issue_number`) WHERE status not in ('COMPLETED', 'ABANDONED');--> statement-breakpoint
CREATE INDEX `tasks_repository_status_idx` ON `tasks` (`repository_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_pr_idx` ON `tasks` (`repository_id`,`github_pr_number`);