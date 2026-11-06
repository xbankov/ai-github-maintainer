# AI GitHub Maintainer

A human-in-the-loop maintainer for GitHub repositories. It analyses issues with an
AI coding agent (OpenCode), proposes changes as issue comments, implements only
what a human explicitly approves, and opens pull requests. **It never merges.**

The full requirements are in [SPEC.md](SPEC.md).

## Status

| Milestone                    | Scope                                                                                                                               | State   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1 — Foundation               | project setup, SQLite + migrations, GitHub App auth, configuration, OpenCode connection, workspaces, health checks, logging, Docker | ✅ done |
| 2 — Discovery and approval   | polling scheduler, job queue, label gate, issue analysis, proposals, `/ai` commands, status labels                                  | ✅ done |
| 3 — Implementation           | OpenCode session per issue, approval in OpenCode, draft PR, CI in GitHub Actions with fix rounds                                    | ✅ done |
| 4 — Review loop and features | review rounds, PR approval stop, merge/close detection, cleanup, feature proposals                                                  | ✅ done |

## How it works

The OpenCode web UI is the console: every issue gets its own OpenCode session,
where the agent and the maintainer talk privately. GitHub only gets short status
notes, the approved plan and the pull request.

1. A maintainer (listed in `github.authorized_users`) adds the label
   **`ai:allowed`** to an issue. Labels added by anyone else are ignored.
2. Within ~5 minutes the bot creates the OpenCode session `<repo>#<n> — <title>`
   and comments a link to it on the issue. The agent investigates (read-only) and
   may ask questions there.
3. You discuss in the session. If it waits for you for 30 minutes, the bot
   @mentions you on the issue with the session link.
4. You approve **in your own words** in the session ("ok, implement it"). A strict
   check accepts only a clear go-ahead. The bot posts the approved plan on the
   issue, including how it differs from the issue description.
5. The same session implements the plan; the bot pushes `ai/issue-<n>` and opens a
   **draft** pull request. CI runs in GitHub Actions; failures go back to the agent
   (up to `max_implementation_retries` rounds). Then the PR is ready for review.
6. Review the PR. Maintainer review comments (or messages in the session) start
   another round in the same session (up to `max_review_iterations`). Feedback that
   goes beyond the approved plan goes back to the session for a new approval.
7. When you approve the PR, the bot stops. **You merge.** After the merge the task
   is completed, the repository is free for the next issue and the worktree is removed.

To stop or decline: close the issue, remove `ai:allowed`, or close the PR.
When the repository is idle, the AI suggests up to 3 ideas as issues labelled
`ai:proposal`; nothing happens with them unless you add `ai:allowed`.

Status labels (set by the bot, display only): `ai:queued`, `ai:running`,
`ai:waiting-for-input` (your turn in OpenCode), `ai:waiting-for-review` (PR).
The bot works on one issue at a time and never merges.

## Architecture

```text
GitHub ◀──poll every 5 min (REST, GitHub App)── orchestrator (Docker, this repo)
                                                │  SQLite: tasks, proposals, decisions, jobs, audit log
                                                │  git: bare clones + one worktree per task
                                                ▼
                               OpenCode server (host, `opencode serve`)
                               agents: maintainer-plan / maintainer-build
```

- **Orchestrator** (Node.js 22, TypeScript, Fastify) owns all workflow state, all
  GitHub API calls and all git network operations. GitHub tokens never reach the
  coding agent.
- **OpenCode** runs as a separate, long-lived process on the host. The
  orchestrator connects to it with the official `@opencode/client` package and
  creates one session per task, confined to the task's worktree.
- **SQLite** (Drizzle ORM, WAL mode) is the source of truth. OpenCode
  conversation history is not.
- Every task status change goes through `src/orchestrator/state-machine.ts` and
  must name the event that justifies it (e.g. only an approval command can move
  `AWAITING_APPROVAL → APPROVED`; only a merge event can reach `COMPLETED`).

### Layout

```text
src/
  index.ts              entry point (HTTP server, start-up checks, graceful shutdown)
  app.ts                wiring of all components
  cli.ts                operator CLI: pause / resume / status
  config/               YAML + environment loading and validation (zod)
  database/             schema, migrations, repository sync, task transitions, kill switch
  github/app.ts         GitHub App auth, installation lookup, scoped tokens, access checks
  opencode/client.ts    OpenCode connection (@opencode/client), session permissions
  orchestrator/         state machine, discovery/sync, analysis, approvals, scheduler, prompts
  workers/              SQLite job queue and processor
  workspace/            git runner and bare-clone/worktree manager
  http/server.ts        /healthz and /readyz
  health.ts             readiness aggregation (cached external checks)
config/repositories.example.yaml
prompts/                    agent prompt templates
scripts/opencode-smoke.ts   manual end-to-end check against the real OpenCode server
scripts/analysis-dry-run.ts manual issue analysis on a local checkout (posts nothing)
tests/                      unit and integration tests (vitest)
```

## Prerequisites

- Linux host with Docker Compose, Node.js 22 and git.
- A running OpenCode **2.2.x** server (`opencode serve`) with basic-auth password.
  The `@opencode/client` version in `package.json` must match the server's
  major.minor version; `/readyz` reports a mismatch.
- A GitHub App (below).

### OpenCode agents

The maintainer uses two dedicated agents. Add them to the OpenCode config
(`~/.config/opencode/opencode.jsonc`) and restart the server. They deny every
tool by default (including all MCP servers and web access) and never leave the
session directory:

```jsonc
"agent": {
  "maintainer-plan": {
    "mode": "primary",
    "description": "AI maintainer: read-only analysis (automated)",
    "permission": {
      "*": "deny", "glob": "allow", "grep": "allow", "list": "allow", "lsp": "allow", "todowrite": "allow",
      "read": { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
      "external_directory": "deny", "webfetch": "deny", "websearch": "deny",
      "question": "deny", "task": "deny", "skill": "deny", "doom_loop": "deny",
      "edit": "deny", "bash": "deny"
    }
  },
  "maintainer-build": {
    "mode": "primary",
    "description": "AI maintainer: implements approved proposals (automated)",
    "permission": {
      "*": "deny", "glob": "allow", "grep": "allow", "list": "allow", "lsp": "allow", "todowrite": "allow",
      "read": { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
      "external_directory": "deny", "webfetch": "deny", "websearch": "deny",
      "question": "deny", "task": "deny", "skill": "deny", "doom_loop": "deny",
      "edit": "allow",
      "bash": { "*": "deny", "git status*": "allow", "git diff*": "allow", "git log*": "allow", "git show*": "allow", "ls*": "allow" }
    }
  }
}
```

Each session additionally receives the deny-by-default rules in
`BASE_SESSION_PERMISSIONS` (`src/opencode/client.ts`).

### GitHub App

1. github.com → Settings → Developer settings → GitHub Apps → **New GitHub App**.
2. Webhook: leave **inactive** — the maintainer polls GitHub instead.
3. Repository permissions — exactly these, nothing else:
   - Contents: **Read and write**
   - Issues: **Read and write**
   - Pull requests: **Read and write**
   - Metadata: Read-only
   - Actions: **Read-only** (CI logs of the bot's branches)
   - Checks: **Read-only**
   - Commit statuses: **Read-only**
     Never grant Administration or Workflows, or write access to Actions/Checks/Statuses;
     `/readyz` fails if they are granted.
4. Events: none needed (no webhook).
5. "Only on this account" → Create. Note the **App ID**, generate a **private key**.
6. **Install App** → _Only select repositories_ → the configured repositories.
7. Put the App ID and the key into `.env` (see `.env.example`), then delete the
   downloaded `.pem`.

## Setup

```sh
cp .env.example .env && chmod 600 .env        # fill in the secrets
cp config/repositories.example.yaml config/repositories.yaml
mkdir -p /home/ubuntu/ai-maintainer-data/{db,workspaces}   # = DATA_DIR, owned by uid 1000
docker compose up -d --build
curl -s http://127.0.0.1:8787/readyz | jq
```

### Environment variables

All secrets live in `.env` and nowhere else.

| Variable                                                         | Required      | Default        | Purpose                                                            |
| ---------------------------------------------------------------- | ------------- | -------------- | ------------------------------------------------------------------ |
| `DATA_DIR`                                                       | yes (compose) | —              | Host directory for `db/` and `workspaces/`. Keep on the root disk. |
| `HTTP_PORT`                                                      | no            | `8787`         | Host port, bound to 127.0.0.1.                                     |
| `LOG_LEVEL`                                                      | no            | `info`         | `trace` … `fatal`.                                                 |
| `GITHUB_APP_ID`                                                  | for readiness | —              | GitHub App ID.                                                     |
| `GITHUB_APP_PRIVATE_KEY`                                         | for readiness | —              | App private key, one line with `\n`.                               |
| `GITHUB_APP_PRIVATE_KEY_PATH`                                    | alternative   | —              | Path to a PEM file instead of the inline key.                      |
| `OPENCODE_SERVER_USERNAME`                                       | no            | `opencode`     | OpenCode basic-auth user.                                          |
| `OPENCODE_SERVER_PASSWORD`                                       | yes           | —              | OpenCode basic-auth password.                                      |
| `MAINTAINER_PAUSED`                                              | no            | `false`        | Kill switch that cannot be lifted at runtime.                      |
| `CONFIG_PATH` / `DATABASE_PATH` / `WORKSPACE_ROOT` / `HTTP_HOST` | no            | set by compose | Overrides for local development.                                   |

### Repository configuration

`config/repositories.yaml` (validated at start-up; unknown keys are errors).
Adding a repository needs only a new entry plus installing the App on it. Per
repository you can set `commands` (test, lint, build, format, typecheck),
`opencode` overrides (agents, model) and free-text `instructions`. See
[config/repositories.example.yaml](config/repositories.example.yaml).

`github.authorized_users` are the maintainers; `github.allowed_label`
(default `ai:allowed`) is the label that enables an issue. Because only
maintainer-labelled issues reach the model, public repositories are safe to use.
`discovery.poll_interval_seconds` (default 300) sets the polling interval;
`discovery.schedule` adds a daily full run (default 08:00).

## Operations

| Task                                          | Command                                                          |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Liveness                                      | `curl http://127.0.0.1:8787/healthz`                             |
| Readiness (DB, OpenCode, GitHub, kill switch) | `curl http://127.0.0.1:8787/readyz` (503 when not ready)         |
| Pause everything                              | `docker compose exec maintainer node dist/cli.js pause "reason"` |
| Resume                                        | `docker compose exec maintainer node dist/cli.js resume`         |
| Status                                        | `docker compose exec maintainer node dist/cli.js status`         |
| Logs (JSON)                                   | `docker compose logs -f maintainer`                              |

Nothing needs to be exposed to the internet (GitHub is polled). Never expose
`/readyz` or the OpenCode API publicly.

## Development

```sh
npm ci                 # npm 11 required (npm 9/10 crash on this dependency tree)
npm run check          # typecheck + lint + format check + tests
npm run dev            # watch mode (needs .env values exported and local paths)
npm run db:generate    # new migration after changing src/database/schema.ts

# Manual end-to-end check against the real OpenCode server (uses a little model quota):
OPENCODE_SERVER_PASSWORD=... OPENCODE_URL_OVERRIDE=http://127.0.0.1:4096 npm run smoke:opencode
```

Tests never touch real repositories: git tests use local `file://` remotes and
GitHub/OpenCode are mocked at the HTTP level.

## Deviations from SPEC.md and known limitations

- **OpenCode package.** The spec names `@opencode-ai/sdk`; its newest release
  (1.19.x) targets the OpenCode 1.x API and fails against OpenCode 2.x. This
  project uses the official 2.x client `@opencode/client` (same repository,
  version-matched to the server).
- **Config location.** Repository configuration lives in top-level `config/`
  (mounted read-only) instead of `src/config/`, so it can change without a rebuild.
- **Extra tables.** `locks`, `feature_fingerprints`, `settings` (kill switch) and
  `audit_log` complement the six tables of SPEC §5.
- **Agent isolation is rule-based.** The coding agent runs inside the host's
  OpenCode server as the host user; it is confined by OpenCode permission rules
  (deny-by-default, no external directories, no MCP/web tools), not by an OS
  sandbox.
- **Structured output.** OpenCode 2.x has no JSON-schema response mode; answers
  are requested as JSON and validated with zod before use (up to 3 attempts
  with feedback).
- **Polling instead of webhooks.** There is no public HTTPS endpoint, so GitHub is
  polled every 5 minutes (configurable). Reactions take up to one interval;
  nothing is exposed to the internet. `GITHUB_WEBHOOK_SECRET` is unused.
- **Label gate.** Issues are processed only after a maintainer adds
  `ai:allowed` (decided with the project owner); the spec processes all open
  issues.
- **Approval with open questions.** A valid proposal with a plan can be approved
  even if it lists open questions; approving accepts the plan as written.
