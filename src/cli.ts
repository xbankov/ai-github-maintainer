/**
 * Operator CLI.
 *   node dist/cli.js pause [reason]   – engage the global kill switch
 *   node dist/cli.js resume           – release it
 *   node dist/cli.js status           – show kill switch + readiness
 */
import { stdout } from "node:process";
import { createApplication } from "./app.js";
import { loadConfig } from "./config/load.js";
import { closeDatabase, openDatabase } from "./database/client.js";
import { getKillSwitch, setKillSwitch } from "./database/settings.js";
import { createLogger } from "./logger.js";

const [command, ...rest] = process.argv.slice(2);
const actor = `cli:${process.env.USER ?? "operator"}`;

function print(value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function run(): Promise<number> {
  const config = loadConfig();
  switch (command) {
    case "pause":
    case "resume": {
      const db = openDatabase({ path: config.paths.database });
      try {
        setKillSwitch(db, command === "pause", actor, rest.join(" ") || undefined);
        print(getKillSwitch(db, config.env.MAINTAINER_PAUSED));
      } finally {
        closeDatabase(db);
      }
      return 0;
    }
    case "status": {
      const app = await createApplication(config, createLogger("warn"));
      try {
        const report = await app.health.report(true);
        print(report);
        return report.ready ? 0 : 1;
      } finally {
        await app.close();
      }
    }
    default:
      stdout.write("usage: cli <pause [reason] | resume | status>\n");
      return 2;
  }
}

run().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  },
);
