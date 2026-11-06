import { z } from "zod";
import { STATUS_LABEL_NAMES } from "../github/issues.js";

/**
 * Repository configuration (config/repositories.yaml).
 * Secrets never live here — see env.ts.
 */

const commandList = z
  .array(z.string().min(1))
  .default([])
  .describe("Shell commands run inside the task worktree, in order. Empty = not applicable.");

const ghName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/, "must be a valid GitHub owner/repository name segment");

export const repositorySchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes only")
      .describe("Stable internal identifier. Changing it creates a new repository record."),
    owner: ghName,
    name: ghName,
    enabled: z.boolean().default(true),
    default_branch: z.string().min(1).default("main"),
    max_concurrent_tasks: z.number().int().min(1).max(5).default(1),
    commands: z
      .object({
        test: commandList,
        lint: commandList,
        build: commandList,
        format: commandList,
        typecheck: commandList,
      })
      .strict()
      .default({ test: [], lint: [], build: [], format: [], typecheck: [] }),
    opencode: z
      .object({
        analysis_agent: z.string().min(1).optional(),
        implementation_agent: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    instructions: z
      .string()
      .default("")
      .describe("Extra trusted instructions for the agent, written by the operator."),
  })
  .strict();

export const configSchema = z
  .object({
    repositories: z.array(repositorySchema).min(1),
    github: z
      .object({
        /** Maintainers: may enable issues (allowed_label) and use /ai commands. */
        authorized_users: z.array(ghName).min(1),
        /**
         * An issue is processed only after a maintainer adds this label.
         * Labels added by anyone else are ignored.
         */
        allowed_label: z
          .string()
          .min(1)
          .default("ai-allowed")
          .refine(
            (l) => !STATUS_LABEL_NAMES.some((s) => s.toLowerCase() === l.toLowerCase()),
            "must not be one of the bot-managed status labels",
          ),
        /** Deprecated (replaced by allowed_label); accepted and ignored with a warning. */
        trusted_issue_authors: z.array(ghName).optional(),
        proposal_label: z.string().min(1).default("ai-proposal"),
        api_url: z.url().default("https://api.github.com"),
      })
      .strict(),
    discovery: z
      .object({
        schedule: z.string().min(1).default("0 8 * * *"),
        timezone: z.string().min(1).default("Europe/Berlin"),
        /** How often GitHub is polled for changes (replaces webhooks). */
        poll_interval_seconds: z.number().int().min(60).default(300),
        issue_batch_size: z.number().int().min(1).max(20).default(3),
        feature_suggestions: z.number().int().min(0).max(10).default(3),
      })
      .strict()
      .default({
        schedule: "0 8 * * *",
        timezone: "Europe/Berlin",
        poll_interval_seconds: 300,
        issue_batch_size: 3,
        feature_suggestions: 3,
      }),
    opencode: z
      .object({
        server_url: z.url(),
        analysis_agent: z.string().min(1).default("maintainer-plan"),
        implementation_agent: z.string().min(1).default("maintainer-build"),
        model: z
          .string()
          .regex(/^[^/\s]+\/\S+$/, "must be provider/model, e.g. opencode-go/deepseek-v4.1-flash")
          .optional(),
        request_timeout_ms: z.number().int().min(1000).default(15_000),
      })
      .strict(),
    limits: z
      .object({
        max_review_iterations: z.number().int().min(0).default(5),
        max_implementation_retries: z.number().int().min(0).default(3),
        max_concurrent_implementations: z.number().int().min(1).default(1),
        task_timeout_minutes: z.number().int().min(1).default(60),
        /** Timeout for one issue analysis by the agent. */
        analysis_timeout_minutes: z.number().int().min(1).default(15),
        /** Jobs (analyses, syncs) running at the same time across all repositories. */
        max_parallel_jobs: z.number().int().min(1).max(4).default(1),
      })
      .strict()
      .default({
        max_review_iterations: 5,
        max_implementation_retries: 3,
        max_concurrent_implementations: 1,
        task_timeout_minutes: 60,
        analysis_timeout_minutes: 15,
        max_parallel_jobs: 1,
      }),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seenIds = new Set<string>();
    const seenRepos = new Set<string>();
    cfg.repositories.forEach((r, i) => {
      if (seenIds.has(r.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["repositories", i, "id"],
          message: `duplicate id "${r.id}"`,
        });
      }
      const full = `${r.owner}/${r.name}`.toLowerCase();
      if (seenRepos.has(full)) {
        ctx.addIssue({
          code: "custom",
          path: ["repositories", i],
          message: `duplicate repository ${full}`,
        });
      }
      seenIds.add(r.id);
      seenRepos.add(full);
    });
  });

export type RepositoryConfig = z.infer<typeof repositorySchema>;
export type FileConfig = z.infer<typeof configSchema>;
