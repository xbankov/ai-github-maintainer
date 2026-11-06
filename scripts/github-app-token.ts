/**
 * Prints a short-lived (1 h) GitHub App installation token for one repository.
 * Development helper for scripts/bot-pr.sh — use only inside command
 * substitution, never echo it.
 *
 *   TOKEN=$(npx tsx scripts/github-app-token.ts xbankov/ai-github-maintainer)
 *
 * Reads GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (inline) or
 * GITHUB_APP_PRIVATE_KEY_PATH from .env, like the service does.
 */
import { readFileSync } from "node:fs";
import { App } from "octokit";

const [full = "xbankov/ai-github-maintainer"] = process.argv.slice(2);
const [owner, repo] = full.split("/") as [string, string];

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
) as Record<string, string | undefined>;

const privateKey = env.GITHUB_APP_PRIVATE_KEY_PATH
  ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8")
  : env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
if (!env.GITHUB_APP_ID || !privateKey) {
  process.stderr.write(
    "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH) are required in .env\n",
  );
  process.exit(1);
}

const app = new App({ appId: env.GITHUB_APP_ID, privateKey });
const { data } = await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
  owner,
  repo,
});
const auth = (await app.octokit.auth({
  type: "installation",
  installationId: data.id,
  repositoryNames: [repo],
  permissions: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    // Read CI results and logs of the bot's pull requests.
    actions: "read",
    checks: "read",
    statuses: "read",
  },
})) as { token: string };
process.stdout.write(auth.token);
