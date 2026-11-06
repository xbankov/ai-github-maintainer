# Working on this repository (instructions for coding agents)

Read SPEC.md (including its Amendments section) and README.md first.

## Pull request process (mandatory)

Every change goes through a pull request opened by the bot
`xbankov-ai-maintainer[bot]`, so a human can approve it. Use
`scripts/bot-pr.sh` (GitHub App token in memory only, never print it).

1. Branch from `main` (`milestone-N` or `fix/<topic>`). Never push to `main`. Never merge.
2. `npm run check` must pass. Commit (end the message with the Co-Authored-By line).
3. `scripts/bot-pr.sh push <branch>`
4. `scripts/bot-pr.sh open <branch> "<title>" <body-file>` — short body: what changed, how it was tested.
5. `scripts/bot-pr.sh wait <pr> 20` (run in the background) — waits for Sourcery's review of the PR head.
6. `scripts/bot-pr.sh threads <pr>` — then for **every** unresolved thread:
   - valid → fix it, add or adjust a test, `npm run check`, commit, push;
   - not valid → do not change the code.
   - Reply and resolve: `scripts/bot-pr.sh reply <thread-id> <body-file>`.
7. Never ask Sourcery to re-review (no `@sourcery-ai review`). Handle only the reviews it posts on its own.
8. Tell the user the PR is ready for their approval and merge.

## Thread reply style

- Brief, plain language, no jargon.
- First line: `Fixed in <short-sha>.` or `Not changing.`
- Then 1–3 bullet points. No semicolons, no long sentences.
- Name the test that covers the fix, if any.

Example:

```
Fixed in d5ee357.
- The command is saved before anything else.
- If GitHub fails, the next poll finishes it.
- Test: "resumes a command whose reply failed".
```

## Rules

- Secrets live only in `.env`. Never print, log or commit them.
- Never use a personal token; act as the App bot only.
- The live service runs from Docker (`docker compose up -d --build`); rebuild after merging.
