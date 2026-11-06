DROP INDEX `jobs_dedupe_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_active_dedupe_uq` ON `jobs` (`dedupe_key`) WHERE status in ('pending', 'running');