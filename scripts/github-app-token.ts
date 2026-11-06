/**
 * Prints a short-lived (1 h) GitHub App installation token for one repository,
 * scoped to contents / pull requests / issues. Development helper for
 * scripts/bot-pr.sh — use only inside command substitution, never echo it.
 *
 *   TOKEN=$(npx tsx scripts/github-app-token.ts xbankov/ai-github-maintainer)
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
if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
  process.stderr.write("GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY missing in .env\n");
  process.exit(1);
}
const app = new App({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
});
const { data } = await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
  owner,
  repo,
});
const auth = (await app.octokit.auth({
  type: "installation",
  installationId: data.id,
  repositoryNames: [repo],
  permissions: { contents: "write", pull_requests: "write", issues: "write" },
})) as { token: string };
process.stdout.write(auth.token);
