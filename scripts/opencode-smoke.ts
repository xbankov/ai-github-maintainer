/**
 * Manual smoke test against the real OpenCode server (not part of `npm test`).
 * Creates a throwaway directory, opens a session with the analysis agent in it,
 * lets the agent inspect a file, then asks for a JSON answer and validates it.
 * Verifies auth, agent, model and structured answers end to end.
 *
 *   OPENCODE_SERVER_PASSWORD=... OPENCODE_URL_OVERRIDE=http://127.0.0.1:4096 npm run smoke:opencode
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../src/config/load.js";
import { createLogger } from "../src/logger.js";
import { OpenCode } from "../src/opencode/client.js";

const resultSchema = z.object({
  language: z.string(),
  function_names: z.array(z.string()),
  has_bug: z.boolean(),
  explanation: z.string(),
});

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return JSON.parse((fenced?.[1] ?? text).trim());
}

async function main() {
  const config = loadConfig();
  const settings = config.file.opencode;
  const opencode = new OpenCode({
    serverUrl: process.env.OPENCODE_URL_OVERRIDE ?? settings.server_url,
    username: config.env.OPENCODE_SERVER_USERNAME,
    password: config.env.OPENCODE_SERVER_PASSWORD,
    requiredAgents: [settings.analysis_agent],
    timeoutMs: 30_000,
    logger: createLogger("warn"),
  });

  const status = await opencode.check();
  console.log("server:", status.serverVersion, "check:", status.ok ? "ok" : status.problems);
  if (!status.ok) process.exit(1);

  const dir = mkdtempSync(join(tmpdir(), "maintainer-smoke-"));
  writeFileSync(
    join(dir, "math.py"),
    "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n",
  );
  const started = Date.now();
  let sessionId: string | undefined;
  try {
    sessionId = await opencode.createSession({
      directory: dir,
      title: "maintainer smoke test",
      agent: settings.analysis_agent,
      model: settings.model,
    });
    const reply = await opencode.run(
      sessionId,
      "Read math.py and review it: which functions exist, and is any of them wrong?",
      300_000,
    );
    console.log("agent reply:", reply.slice(0, 300));
    const json = await opencode.generate(
      sessionId,
      `Summarise your review as ONLY a JSON object, no prose, matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(resultSchema))}`,
      120_000,
    );
    console.log("seconds:", ((Date.now() - started) / 1000).toFixed(1));
    console.log("json:", json);
    const parsed = resultSchema.safeParse(extractJson(json));
    console.log("schema valid:", parsed.success, parsed.success ? "" : parsed.error.message);
    process.exitCode = parsed.success && parsed.data.has_bug ? 0 : 1;
  } finally {
    if (sessionId) await opencode.deleteSession(sessionId).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
