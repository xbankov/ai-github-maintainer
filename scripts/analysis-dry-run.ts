/**
 * Manual dry run of the issue analysis against the real OpenCode server and a
 * local checkout — nothing is posted to GitHub.
 *
 *   OPENCODE_SERVER_PASSWORD=... OPENCODE_URL_OVERRIDE=http://127.0.0.1:4096 \
 *     npx tsx scripts/analysis-dry-run.ts <checkout-dir> "<issue title>" "<issue body>"
 */
import { loadConfig } from "../src/config/load.js";
import { createLogger } from "../src/logger.js";
import { OpenCode } from "../src/opencode/client.js";
import { buildAnalysisPrompt, buildProposalJsonPrompt } from "../src/orchestrator/prompts.js";
import { parseProposal, renderProposalComment } from "../src/orchestrator/proposal.js";

const [dir, title, body] = process.argv.slice(2);
if (!dir || !title) {
  console.error("usage: analysis-dry-run.ts <checkout-dir> <title> [body]");
  process.exit(2);
}
const config = loadConfig();
const s = config.file.opencode;
const oc = new OpenCode({
  serverUrl: process.env.OPENCODE_URL_OVERRIDE ?? s.server_url,
  username: config.env.OPENCODE_SERVER_USERNAME,
  password: config.env.OPENCODE_SERVER_PASSWORD,
  requiredAgents: [s.analysis_agent],
  timeoutMs: 30_000,
  logger: createLogger("warn"),
});
const started = Date.now();
const id = await oc.createSession({
  directory: dir,
  title: "analysis dry run",
  agent: s.analysis_agent,
  model: s.model,
});
try {
  const review = await oc.run(
    id,
    buildAnalysisPrompt({
      repository: "dry-run",
      instructions: "Follow AGENTS.md in the repository root.",
      issue: {
        number: 1,
        title,
        body: body ?? "",
        state: "open",
        labels: ["ai-allowed"],
        author: { login: "xbankov", id: 1 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      comments: [],
    }),
    15 * 60_000,
  );
  console.log(
    `--- review (${((Date.now() - started) / 1000).toFixed(0)} s):\n${review.slice(0, 1500)}\n`,
  );
  let error: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = parseProposal(await oc.generate(id, buildProposalJsonPrompt(error), 5 * 60_000));
    if (result.ok) {
      console.log(
        `--- valid proposal on attempt ${attempt}, total ${((Date.now() - started) / 1000).toFixed(0)} s:\n`,
      );
      console.log(renderProposalComment({ taskId: 0, version: 1, proposal: result.proposal }));
      process.exit(0);
    }
    error = result.error;
    console.log(`attempt ${attempt} rejected: ${error.slice(0, 300)}`);
  }
  process.exit(1);
} finally {
  await oc.deleteSession(id).catch(() => undefined);
}
