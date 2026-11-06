# AI GitHub Maintainer — Implementation Specification

## Amendments (agreed with the project owner, 2026-11-06)

These decisions override the corresponding parts of this specification.

1. **Polling instead of webhooks** (§2.1, §2.5, §4 "Webhook Receiver", §8, §9).
   The server has no public HTTPS endpoint. GitHub is polled through the GitHub
   App every 5 minutes (`discovery.poll_interval_seconds`) plus the daily run.
   There is no webhook receiver, no webhook secret and nothing exposed to the
   internet; the GitHub App's webhook stays inactive. The `events` table records
   processed command comments for idempotency instead of webhook deliveries.
2. **Label gate** (§2.1). Only open issues to which a maintainer
   (`github.authorized_users`) added the label `ai:allowed` are processed.
   Labels added by anyone else are ignored. Removing the label or closing the
   issue stops work that has not reached a pull request.
3. **One issue at a time** (§2.1, §13). `discovery.issue_batch_size` defaults
   to 1 per repository and `limits.max_parallel_jobs` to 1 overall.
4. **Status labels.** The bot shows `ai:queued`, `ai:running` and
   `ai:waiting-for-review` on issues (display only; the database is the source
   of truth).
5. **OpenCode client** (§3). OpenCode 2.x is used through the official
   `@opencode/client` package; `@opencode-ai/sdk` 1.x targets the OpenCode 1.x API.
7. **OpenCode is the console** (§2.2, §2.3). Each issue gets one OpenCode
   session (analysis, discussion and implementation). The agent may ask the
   maintainer questions there. Implementation is approved by typing
   `/ai approve` (or `/ai reject`) in the session; the bot then posts the
   approved plan on the issue, including how it differs from the description.
   `/ai` comments on GitHub are answered with the session link. After 30 minutes
   of waiting for input, the maintainer is @mentioned on the issue.
8. **Tests run in GitHub Actions** (§2.4). The bot opens a draft pull request,
   waits for CI, sends failures back to the agent (bounded rounds), and marks the
   PR ready for review when CI passes. AI-written code never runs on the server.
6. **Approval with open questions** (§2.2). A valid proposal with an
   implementation plan may be approved even if it lists open questions;
   approving accepts the plan as written.

## 1. Project Goal

Build a reusable, autonomous AI software-maintenance system that manages multiple GitHub repositories.

The system runs on a home server and uses:

- GitHub App API for repository access.
- GitHub Webhooks for real-time events.
- OpenCode as the AI coding agent.
- SQLite for persistent workflow state and memory.
- TypeScript / Node.js for orchestration.

The initial deployment manages two GitHub repositories, but adding more repositories must require configuration changes only, not additional application code.

The system must implement a human-in-the-loop workflow.

**Critical rule: The AI must never merge pull requests. Only a human can approve and merge changes.**

## 2. Core Workflow

Each repository is managed independently.

### 2.1 Issue Discovery

Run discovery:
- Once daily at 08:00.
- Whenever relevant GitHub issue events arrive.

For each repository:

1. Fetch all open GitHub issues.
2. Exclude pull requests.
3. Exclude issues already being processed.
4. Sort by creation date, oldest first.
5. Select the three oldest eligible issues.
6. Fetch their descriptions, comments, labels and relevant repository context.
7. Analyze each issue using OpenCode in planning mode.
8. Save the analysis in the database.
9. Publish a concise implementation proposal as a GitHub issue comment.
10. Wait for human approval.

An issue must not be considered permanently processed merely because it was previously analyzed.

If its description or circumstances change, it may be analyzed again and receive a new proposal version.

Do not create duplicate proposals for unchanged issues.

### 2.2 Issue Analysis

The AI must determine:

- Does the issue make sense?
- Is it actionable?
- Is it already implemented?
- Is it a duplicate?
- Is it inconsistent with the current architecture?
- What is the likely cause?
- What files or components are affected?
- What implementation would solve it?
- What are the risks?
- What tests are necessary?
- Is clarification required?

The AI must not invent missing requirements.

If an issue is unclear, it should explain what information is missing instead of proposing speculative implementation.

Expected structured response:

```json
{
  "valid": true,
  "summary": "Short description",
  "reasoning": "Why the issue is valid",
  "implementation": [
    "Step one",
    "Step two"
  ],
  "affected_files": [],
  "risks": [],
  "estimated_complexity": "small",
  "questions": []
}
```

Use structured output validation before publishing proposals.

### 2.3 GitHub Approval

Publish proposals as comments on the original GitHub issue.

Supported commands:

- `/ai approve`
- `/ai reject`
- `/ai revise <instructions>`

Only explicitly authorized GitHub users may issue these commands.

Approval must be associated with a specific proposal version.

If a proposal changes after approval, require approval again.

Behavior:

**Approve**
- Persist the approval.
- Change task state to APPROVED.
- Schedule implementation.

**Reject**
- Persist rejection.
- Do not implement.
- Mark the proposal as rejected.

**Revise**
- Send the requested changes back to the analysis agent.
- Generate a new proposal version.
- Publish the updated proposal.
- Wait for approval again.

### 2.4 Implementation

After approval:

1. Acquire a per-repository execution lock.
2. Fetch the latest default branch.
3. Create a dedicated Git worktree.
4. Create a branch, for example `ai/issue-42`.
5. Start an OpenCode implementation session.
6. Provide the approved proposal, original issue and repository instructions.
7. Implement the approved change.
8. Run tests, linting, formatting and type checking as applicable.
9. Fix failures within a configurable retry limit.
10. Commit changes.
11. Push the branch.
12. Create a GitHub pull request.
13. Save the PR number, branch and OpenCode session ID.
14. Transition to PR_OPEN.

Never implement work that has not been explicitly approved.

Use a separate worktree for each task.

### 2.5 Pull Request Review Loop

Listen for:

- `pull_request_review`
- `pull_request_review_comment`
- `issue_comment`
- `pull_request`

Behavior:

**Human requests changes**

1. Fetch the review and relevant comments.
2. Understand the requested changes.
3. Check whether they conflict with the original approved scope.
4. If they are within scope, resume the OpenCode implementation session.
5. Implement the requested changes.
6. Run tests.
7. Commit and push to the same branch.
8. Update the existing PR.
9. Wait for another human review.

If feedback substantially changes the original scope, ask for approval before implementing the additional work.

**Human approves the PR**

- Stop implementation.
- Mark the task READY_FOR_HUMAN_MERGE.
- Do not merge.
- Wait for the actual GitHub merge event.

**PR merged**

- Detect `merged: true`.
- Mark the task COMPLETED.
- Release repository locks.
- Clean up the worktree.
- Allow the next task to proceed.

**PR closed without merging**

- Mark the task ABANDONED.
- Stop implementation.
- Clean up the worktree.

Limit automatic review iterations to five by default. After that, request human intervention.

### 2.6 Feature Discovery

If there are no eligible open issues:

Perform a repository analysis.

Inspect:

- README and documentation.
- Architecture.
- Source code.
- TODO and FIXME comments.
- Existing tests.
- Missing test coverage.
- Incomplete functionality.
- Developer experience.
- Potential usability improvements.

Generate up to three useful feature proposals.

Each proposal should include:

- Title.
- Problem or opportunity.
- Why it matters.
- Suggested implementation.
- Expected benefit.
- Complexity.
- Potential risks.

Compare proposals with previously suggested features to prevent duplicates.

Publish proposals as GitHub issues using the `ai-proposal` label.

Do not implement features without explicit human approval.

Never treat the system's own proposals as ordinary issues to be processed automatically.

Maintain feature fingerprints in the database to avoid repeatedly suggesting the same ideas.

---

## 3. Technology Stack

Use:

| Component | Technology |
|---|---|
| Runtime | Node.js 22+ |
| Language | TypeScript |
| HTTP server | Fastify |
| GitHub integration | Octokit |
| Authentication | GitHub App |
| Webhooks | GitHub Webhooks |
| AI coding agent | OpenCode |
| OpenCode integration | `@opencode-ai/sdk` |
| Database | SQLite |
| ORM | Drizzle ORM |
| Git operations | Git CLI |
| Scheduling | node-cron or systemd timer |
| Deployment | Docker Compose |

Prefer stable, maintained package versions.

Verify current OpenCode SDK documentation before implementing the integration. Use the existing OpenCode server rather than starting a new server for every task.

Keep the orchestrator and OpenCode server as separate processes.

The OpenCode server should be accessible only through localhost or a trusted internal network.

---

## 4. Architecture

Implement the following logical components.

### GitHub Integration

Responsibilities:

- GitHub App authentication.
- Repository discovery.
- Fetching issues and comments.
- Creating issue comments.
- Creating feature proposals.
- Creating pull requests.
- Processing reviews.
- Detecting merged and closed PRs.
- Webhook signature validation.

### Webhook Receiver

Responsibilities:

- Receive GitHub webhook events.
- Verify signatures.
- Validate event types.
- Deduplicate deliveries.
- Persist events.
- Enqueue background jobs.
- Respond quickly to GitHub.

Never execute AI operations directly inside an HTTP webhook request.

### Orchestrator

Responsibilities:

- Manage task lifecycle.
- Validate state transitions.
- Manage approvals.
- Schedule discovery.
- Coordinate workers.
- Handle retries.
- Manage repository locks.
- Recover interrupted work.

### OpenCode Integration

Implement separate capabilities:

- Issue analyzer.
- Feature analyzer.
- Implementation agent.
- Review-feedback implementation agent.

Use OpenCode's Plan agent for analysis and Build agent for implementation where supported.

Persist OpenCode session identifiers to allow sessions to be resumed.

Use separate sessions for independent analysis and implementation tasks.

### Worker Queue

Use a SQLite-backed durable queue.

Requirements:

- Persist jobs before acknowledging their scheduling.
- Support retries with exponential backoff.
- Prevent duplicate execution.
- Support idempotent event processing.
- Recover interrupted jobs after restart.
- Support per-repository locks.
- Limit concurrent implementations.

Do not introduce Redis unless there is a demonstrated need.

---

## 5. Database Design

Use SQLite with Drizzle ORM and migrations.

Implement at least the following tables.

### repositories

- id
- owner
- name
- default_branch
- enabled
- last_discovery_at
- created_at
- updated_at

### tasks

- id
- repository_id
- type (`issue` or `feature`)
- github_issue_number
- github_pr_number
- status
- proposal_version
- approved_version
- opencode_session_id
- branch_name
- iteration_count
- created_at
- updated_at
- completed_at

### proposals

- id
- task_id
- version
- content
- fingerprint
- status
- created_at

### jobs

- id
- type
- payload
- status
- attempts
- max_attempts
- available_at
- locked_at
- created_at
- updated_at

### events

- id
- github_delivery_id
- event_type
- payload
- processed_at
- created_at

### decisions

- id
- task_id
- proposal_version
- decision
- github_user
- github_comment_id
- created_at

Add appropriate indexes, uniqueness constraints and foreign keys.

Persist all important workflow decisions.

The database is the source of truth for workflow state, not OpenCode conversation history.

---

## 6. State Machine

Implement explicit, validated state transitions.

Supported states:

- DISCOVERED
- ANALYZING
- AWAITING_APPROVAL
- REJECTED
- APPROVED
- IMPLEMENTING
- TESTING
- PR_OPEN
- CHANGES_REQUESTED
- READY_FOR_HUMAN_MERGE
- COMPLETED
- ABANDONED
- FAILED

Do not allow arbitrary state changes from webhook payloads.

Examples:

- Only AWAITING_APPROVAL can transition to APPROVED through a valid approval command.
- Only APPROVED can transition to IMPLEMENTING.
- Only PR_OPEN or CHANGES_REQUESTED can transition to review-related states.
- Only a confirmed GitHub merge event can transition to COMPLETED.
- READY_FOR_HUMAN_MERGE must never trigger an automatic merge.

Implement transition validation in a dedicated state-machine module.

---

## 7. Repository Configuration

Repositories must be configurable without modifying application code.

Example:

```yaml
repositories:
  - id: project-a
    owner: YOUR_GITHUB_USERNAME
    name: repository-one
    enabled: true
    default_branch: main
    max_concurrent_tasks: 1

  - id: project-b
    owner: YOUR_GITHUB_USERNAME
    name: repository-two
    enabled: true
    default_branch: main
    max_concurrent_tasks: 1

github:
  authorized_users:
    - YOUR_GITHUB_USERNAME

discovery:
  schedule: "0 8 * * *"
  issue_batch_size: 3
  feature_suggestions: 3

opencode:
  server_url: http://127.0.0.1:4096
  analysis_agent: plan
  implementation_agent: build

limits:
  max_review_iterations: 5
  max_implementation_retries: 3
```

Use environment variables for credentials and secrets.

Do not commit secrets to the repository.

Support repository-specific overrides for:

- Test commands.
- Lint commands.
- Build commands.
- Formatting commands.
- OpenCode agent selection.
- Repository instructions.

---

## 8. Security Requirements

These requirements are mandatory.

### GitHub

- Use a GitHub App.
- Request minimum necessary permissions.
- Restrict access to configured repositories.
- Restrict approval commands to authorized users.
- Verify webhook signatures.
- Deduplicate webhook deliveries.
- Never grant administration permissions.
- Never automatically merge pull requests.

### OpenCode

- Restrict the coding agent to its assigned worktree.
- Never expose GitHub credentials or database credentials to the coding agent.
- Use restricted permissions for shell and file operations.
- Do not allow changes to the default branch.
- Treat issue descriptions, comments and repository files as untrusted input.
- Do not allow repository content to override system-level agent instructions.

### Execution

- Use isolated worktrees.
- Set execution timeouts.
- Limit retries.
- Log all actions.
- Provide a global kill switch.
- Never execute arbitrary commands directly from GitHub comments.

Only explicitly supported commands should be accepted.

---

## 9. Deployment

The application must run on a Linux home server.

Provide:

- Dockerfile.
- Docker Compose configuration.
- Persistent database volume.
- Persistent repository/worktree volume.
- Environment variable documentation.
- Health check endpoint.
- Structured logs.
- Restart policy.

The webhook endpoint must be exposed through HTTPS using a reverse proxy or secure tunnel.

Do not expose the OpenCode API publicly.

The application must recover safely after a restart without losing approval state, pending jobs or PR tracking.

---

## 10. Project Structure

Use a modular structure similar to:

```text
ai-maintainer/
├── src/
│   ├── index.ts
│   ├── github/
│   │   ├── app.ts
│   │   ├── client.ts
│   │   ├── webhooks.ts
│   │   ├── issues.ts
│   │   ├── pull-requests.ts
│   │   └── comments.ts
│   ├── opencode/
│   │   ├── client.ts
│   │   ├── analyzer.ts
│   │   ├── implementer.ts
│   │   └── reviewer.ts
│   ├── orchestrator/
│   │   ├── state-machine.ts
│   │   ├── discovery.ts
│   │   ├── approvals.ts
│   │   ├── implementation.ts
│   │   ├── review-loop.ts
│   │   └── feature-discovery.ts
│   ├── workers/
│   │   ├── queue.ts
│   │   └── processor.ts
│   ├── database/
│   │   ├── schema.ts
│   │   └── migrations/
│   └── config/
│       └── repositories.yaml
├── prompts/
│   ├── analyze-issue.md
│   ├── suggest-feature.md
│   ├── implement-issue.md
│   └── review-feedback.md
├── tests/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
└── README.md
```

You may adjust the structure if there is a clear engineering reason.

---

## 11. Implementation Plan

Implement incrementally.

### Milestone 1: Foundation

- Initialize TypeScript project.
- Configure linting, formatting and tests.
- Implement SQLite and migrations.
- Implement GitHub App authentication.
- Implement repository configuration.
- Connect to the existing OpenCode server.
- Implement repository workspace management.
- Add health checks and structured logging.

### Milestone 2: Discovery and Approval

- Implement scheduled discovery.
- Implement webhook receiver.
- Implement durable job queue.
- Implement oldest-three issue selection.
- Implement OpenCode issue analysis.
- Implement structured proposal validation.
- Publish proposals to GitHub.
- Implement `/ai approve`.
- Implement `/ai reject`.
- Implement `/ai revise`.
- Persist all approvals and proposal versions.

### Milestone 3: Implementation

- Implement Git worktree management.
- Implement OpenCode coding sessions.
- Implement test execution.
- Implement bounded correction retries.
- Implement commits and pushes.
- Implement PR creation.
- Persist session and PR identifiers.

### Milestone 4: Review Loop and Feature Discovery

- Implement review event processing.
- Implement automatic review-feedback iteration.
- Implement human approval detection.
- Implement manual merge detection.
- Implement feature discovery.
- Implement duplicate feature detection.
- Implement cleanup and restart recovery.

---

## 12. Testing Requirements

Write automated tests throughout development.

At minimum:

### Unit tests

- State transitions.
- Approval authorization.
- Proposal versioning.
- Issue sorting.
- Feature fingerprinting.
- Event deduplication.
- Job retries.
- Repository locking.

### Integration tests

- GitHub API interactions using mocks.
- Webhook signature validation.
- OpenCode client integration.
- Database persistence.
- Git worktree creation and cleanup.

### End-to-end scenarios

1. Discover three oldest issues.
2. Publish proposals.
3. Reject a proposal.
4. Approve a proposal.
5. Implement and create a PR.
6. Receive review feedback.
7. Implement corrections.
8. Receive PR approval.
9. Confirm the system does not merge.
10. Detect a manual merge.
11. Mark the task complete.
12. Recover an interrupted task after restart.
13. Generate feature proposals when no eligible issues exist.
14. Ensure generated feature proposals do not trigger an infinite processing loop.

Never use a real production repository for automated destructive tests.

---

## 13. Operational Rules

- Only one implementation per repository by default.
- Multiple independent repositories may be processed simultaneously.
- Discovery must not duplicate active work.
- An approval must never be inferred from an ordinary comment.
- An approved PR must never be automatically merged.
- A closed PR must never be reopened automatically.
- A rejected task must never be implemented without new approval.
- Every implementation must reference an approved proposal.
- Every PR must reference its originating issue or approved feature proposal.
- All important actions must be logged and persisted.
- Failed jobs must be recoverable.
- Human intervention must always be possible.

---

## 14. Definition of Done

The MVP is complete when:

1. Both repositories can be configured independently.
2. Daily discovery works.
3. GitHub webhooks trigger relevant workflows.
4. The three oldest eligible issues are analyzed.
5. Proposals are published to GitHub.
6. Authorized users can approve, reject and revise proposals.
7. Approved issues can be implemented by OpenCode.
8. Changes are tested and submitted as PRs.
9. Review feedback can trigger additional implementation iterations.
10. The agent stops when a human approves the PR.
11. The agent never merges a PR.
12. Manual merges are detected.
13. Feature proposals are generated when no eligible issues exist.
14. State survives application restarts.
15. Automated tests cover the critical workflows.

---

## 15. Instructions to OpenCode

You are acting as the senior software architect and lead engineer responsible for implementing this project.

Follow these rules:

1. First inspect the existing repository and its current state.
2. Read this specification completely.
3. Create an implementation plan before writing code.
4. Identify ambiguities, missing requirements and architectural risks.
5. Prefer simple, maintainable solutions over unnecessary abstractions.
6. Use current official documentation for OpenCode and GitHub APIs.
7. Implement incrementally, following the milestones.
8. Write tests alongside implementation.
9. Keep documentation and configuration examples up to date.
10. Do not silently omit requirements.
11. Do not invent credentials, repository names or deployment details.
12. Never commit secrets.
13. Never merge pull requests.
14. Report decisions that require human input rather than making potentially destructive assumptions.

### Initial execution instruction

**Do not immediately implement the entire project.**

First:

- Inspect the repository.
- Produce a concise architecture and implementation plan.
- Identify prerequisites and required secrets.
- Identify any conflicts between this specification and the existing repository.
- Propose a concrete Milestone 1 implementation plan.
- List decisions that genuinely require human input.

Wait for human approval before starting implementation.

After approval, implement Milestone 1 completely, run its tests, and report the result before proceeding to the next milestone.

The objective is a production-conscious, reliable and reusable AI GitHub maintainer, not merely a demonstration or prototype.
